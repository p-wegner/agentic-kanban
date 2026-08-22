// Boot-time recovery for sessions running on a fleet worker (#745).
//
// Decision 012 promises that a worker's result "will land from the incoming ref on
// the next startup sweep" after a board restart. `cleanupStaleSessions` defeated the
// promise before the sweep ever ran: it marked EVERY pid-less `running` session
// `stopped` and idled its workspace — and a remote session has no local pid by
// construction. The worker then reconnected, its `hello` found a terminal row, and
// the board answered by telling it to STOP an agent that had been working. The DB
// question was answered wrongly by the sweep that ran first.
//
// So a worker-stamped session is not swept. It is RE-ADOPTED: the session's
// in-memory context is restored (so broadcast/activity/exit handling work) and the
// remote service is handed a rebuilt output callback, which is what makes the
// worker's next event — and its exit — land through the normal path instead of being
// dropped as "a session we do not track". Only a session whose worker is provably
// gone (revoked, or silent past the abandon bound) is finalized, and the reason is
// named.
//
// What this CANNOT recover, stated rather than papered over:
//  - The worker's pending-result queue is in-memory and capped at 200
//    (`PENDING_QUEUE_CAP`), so an exit it queued while the board was down is lost on
//    a worker-daemon restart. Re-adoption recovers the sessions whose worker process
//    survived; it cannot recover an event that no longer exists anywhere.
//  - Live stdout produced during the gap is gone (decision 012, deliberately).
//  - The git token the worker holds lives only in an in-memory store, so a worker
//    finishing a push after a board restart gets 401 regardless of what happens
//    here. That is the second half of #745 and needs a persisted token digest.

import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import { listRunningWorkerSessions } from "../repositories/remote-session.repository.js";
import { updateSessionStoppedNoStats } from "../repositories/session-lifecycle.repository.js";
import { setWorkspaceStatus } from "../repositories/workspace-status.repository.js";
import type { LivenessVerdict } from "../services/remote-session-liveness.js";
import { probeRemoteSessionLiveness } from "../services/fleet-liveness-probe.js";
import type { RemoteAgentService } from "../services/agent-remote.service.js";
import type { AgentOutputEvent } from "../services/agent.service.js";

/** The slice of SessionManager this needs — keeps the boot path testable without a WS server. */
export interface RemoteReadoptionSessionManager {
  reattachSession(opts: {
    sessionId: string;
    workspaceId: string;
    issueId: string;
    projectId: string;
    providerName?: string;
  }): void;
  handleOutput(sessionId: string, event: AgentOutputEvent): void;
  notifyExternalExit(sessionId: string, exitCode: number | null): Promise<void>;
}

export interface RemoteReadoptionResult {
  adopted: string[];
  finalized: string[];
}

export interface RemoteReadoptionDeps {
  sessionManager: RemoteReadoptionSessionManager;
  database?: Database;
  /** Injected for testing — the live one comes from the worker fleet. */
  remoteService?: RemoteAgentService;
  probe?: (
    row: { workerId: string; startedAt?: string | null },
    database: Database,
    opts: { nowMs: number },
  ) => Promise<LivenessVerdict>;
  /** Does this worker share the board's filesystem? Only a TRUE remote needs git-transport landing. */
  sharesFilesystem?: (workerId: string) => Promise<boolean>;
  /** ISO now (persisted into session/workspace rows). */
  now?: string;
}

/**
 * Re-adopt (or, when the evidence says the worker is gone, finalize) every session
 * this board left running on a fleet worker. Returns what it did, so the boot log can
 * say it out loud.
 */
export async function readoptRemoteSessions(deps: RemoteReadoptionDeps): Promise<RemoteReadoptionResult> {
  const database = deps.database ?? realDb;
  const now = deps.now ?? new Date().toISOString();
  const nowMs = new Date(now).getTime();
  const probe = deps.probe ?? probeRemoteSessionLiveness;
  const result: RemoteReadoptionResult = { adopted: [], finalized: [] };

  const rows = await listRunningWorkerSessions(database);

  if (rows.length === 0) return result;

  const remote = deps.remoteService ?? (await defaultRemoteService(database));
  console.log(`[startup] ${rows.length} session(s) were running on fleet worker(s) — deciding each on evidence`);

  for (const row of rows) {
    const workerId = row.workerId;
    if (!workerId) continue;
    const verdict = await probe({ workerId, startedAt: row.startedAt }, database, { nowMs }).catch((err) => {
      console.error(`[startup] remote liveness probe failed for session ${row.sessionId}`, err);
      return { liveness: "unknown" as const, reason: "remote liveness probe failed" };
    });

    if (verdict.liveness === "dead") {
      console.warn(
        `[startup] remote session ${row.sessionId} cannot be recovered: ${verdict.reason} — marking stopped`,
      );
      await updateSessionStoppedNoStats(row.sessionId, now, database);
      await setWorkspaceStatus(database, row.workspaceId, "idle", { now });
      result.finalized.push(row.sessionId);
      continue;
    }

    // alive or unknown: HOLD the row as `running` and rebuild the plumbing.
    deps.sessionManager.reattachSession({
      sessionId: row.sessionId,
      workspaceId: row.workspaceId,
      issueId: row.issueId,
      projectId: row.projectId,
      providerName: row.executor ?? undefined,
    });

    const sharesFs = deps.sharesFilesystem
      ? await deps.sharesFilesystem(workerId).catch(() => false)
      : await defaultSharesFilesystem(workerId, database);
    const repo = sharesFs || !row.repoPath ? undefined : { repoPath: row.repoPath, branch: row.branch };

    remote?.adoptSession({
      sessionId: row.sessionId,
      workerId,
      // Mirrors the host reattach path: broadcast/persist every event, and let the
      // lifecycle finalize the row on exit (broadcast alone does not).
      onOutput: (event) => {
        deps.sessionManager.handleOutput(row.sessionId, event);
        if (event.type === "exit") {
          void deps.sessionManager
            .notifyExternalExit(row.sessionId, event.exitCode ?? null)
            .catch((err) => console.error(`[startup] adopted session exit handling failed: ${row.sessionId}`, err));
        }
      },
      repo,
    });
    console.log(
      `[startup] re-adopted remote session ${row.sessionId} on worker ${workerId} (${verdict.reason})` +
        (repo ? ` — its push will land on ${repo.branch}` : ""),
    );
    result.adopted.push(row.sessionId);
  }

  return result;
}

/** Lazy so the boot path can be tested without constructing the fleet. */
async function defaultRemoteService(database: Database): Promise<RemoteAgentService | undefined> {
  try {
    const { getWorkerFleet } = await import("../services/worker-fleet.service.js");
    return getWorkerFleet(database).remoteAgentService as RemoteAgentService;
  } catch (err) {
    console.error("[startup] could not reach the worker fleet to re-adopt remote sessions", err);
    return undefined;
  }
}

async function defaultSharesFilesystem(workerId: string, database: Database): Promise<boolean> {
  try {
    const { getWorkerFleet, workerSharesFilesystem } = await import("../services/worker-fleet.service.js");
    return await workerSharesFilesystem(getWorkerFleet(database), workerId);
  } catch {
    // Unknown: assume a TRUE remote, so the landing step runs. Landing a ref that was
    // never pushed is reported and harmless; skipping it orphans real work.
    return false;
  }
}

/**
 * The boot entry point: never throws, and deliberately does NOT fall back to the pid
 * sweep on failure — sweeping a remote session is the bug this guards against.
 */
export async function recoverRemoteSessionsAtBoot(
  sessionManager: RemoteReadoptionSessionManager,
  database?: Database,
): Promise<RemoteReadoptionResult> {
  try {
    const res = await readoptRemoteSessions({ sessionManager, database });
    if (res.adopted.length > 0 || res.finalized.length > 0) {
      console.log(
        `[startup] fleet recovery: re-adopted ${res.adopted.length} remote session(s), ` +
          `finalized ${res.finalized.length} whose worker is provably gone`,
      );
    }
    return res;
  } catch (err) {
    console.error("[startup] remote-session re-adoption failed (non-fatal); leaving those rows alone", err);
    return { adopted: [], finalized: [] };
  }
}
