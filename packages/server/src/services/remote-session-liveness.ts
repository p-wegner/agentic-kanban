// The one place "is this session's agent still alive?" is decided (#744/#745/#746).
//
// Every board reconciler used to answer that question from the SAME local
// evidence: `sessions.pid`. For a host session that is sound — the board spawned
// the process, so a null pid means no process was ever tracked and a dead pid
// means it is gone. For a REMOTE session it is a category error: the board is an
// OBSERVER, not the owner. There is no local pid, there never will be, and the
// absence of one is absence of INFORMATION, not evidence of death.
//
// Three bugs were the same mistake:
//  - #744 the completion-state reconciler force-stopped every running remote
//    session ("pid=null (no process was tracked)") on the first tick.
//  - #745 the boot sweep marked every pid-less running session `stopped`, so a
//    reconnecting worker's hello found a terminal row and the board told it to
//    stop an agent that was working.
//  - #746 a 60 s socket gap synthesized `exit(1)` while the agent still ran.
//
// So liveness is a THREE-valued answer here, and `unknown` is a first-class
// verdict with an explicit policy attached: HOLD (change nothing), REPORT (log a
// line naming what we cannot see), WAIT, and only give up when the evidence
// actually says the worker is gone — it was revoked, or it has been silent past
// the abandon bound. "Give up" is then a decision with a reason, not an accident
// of a null column.

import type { Database } from "../db/index.js";
import { db as realDb } from "../db/index.js";
import { getWorkerById } from "../repositories/worker.repository.js";
import { WORKER_HEARTBEAT_STALE_MS } from "./worker-registry.service.js";

export type Liveness = "alive" | "dead" | "unknown";

export interface LivenessVerdict {
  liveness: Liveness;
  /** Always populated — an `unknown` that cannot be reported is indistinguishable from a guess. */
  reason: string;
}

/**
 * How long a remote session may stay `unknown` before the board gives up on it.
 *
 * Deliberately much longer than the reconnect grace: a laptop lid, a VPN flap or
 * a worker-daemon supervisor backoff are minutes, not seconds, and the cost of
 * waiting (a workspace held) is far below the cost of being wrong (two agents on
 * one branch, or destroyed work). Measured from the last POSITIVE evidence: the
 * worker's last heartbeat, falling back to the session's own start.
 */
export const REMOTE_SESSION_ABANDON_MS = 30 * 60 * 1000;

export interface RemoteEvidence {
  /** False when no `workers` row exists any more — revoked or deleted. */
  workerExists: boolean;
  /** Is a live WebSocket held for this worker right now? */
  workerConnected: boolean;
  /** ISO of the last positive evidence (worker heartbeat, else session start). */
  lastEvidenceAt: string | null;
}

/**
 * Liveness of a session running on a fleet worker, from evidence the board can
 * actually observe. Never returns `dead` because a pid is missing — a remote
 * session has no pid by construction.
 */
export function classifyRemoteSessionLiveness(
  evidence: RemoteEvidence,
  opts: { workerId: string; nowMs?: number; abandonAfterMs?: number } = { workerId: "?" },
): LivenessVerdict {
  const nowMs = opts.nowMs ?? Date.now();
  const abandonAfterMs = opts.abandonAfterMs ?? REMOTE_SESSION_ABANDON_MS;
  const workerId = opts.workerId;

  if (!evidence.workerExists) {
    // The operator revoked (or deleted) this worker. That is a decision, not a
    // gap: nothing will ever report on this session again.
    return { liveness: "dead", reason: `worker ${workerId} no longer exists (revoked or deleted)` };
  }
  if (evidence.workerConnected) {
    return { liveness: "alive", reason: `worker ${workerId} is connected` };
  }
  const sinceMs = evidence.lastEvidenceAt ? Date.parse(evidence.lastEvidenceAt) : NaN;
  const silentForMs = Number.isFinite(sinceMs) ? nowMs - sinceMs : null;
  if (silentForMs !== null && silentForMs > abandonAfterMs) {
    return {
      liveness: "dead",
      reason:
        `worker ${workerId} has been silent for ${Math.round(silentForMs / 60000)}m ` +
        `(> the ${Math.round(abandonAfterMs / 60000)}m abandon bound)`,
    };
  }
  const silence = silentForMs === null ? "an unknown time" : `${Math.round(silentForMs / 1000)}s`;
  return {
    liveness: "unknown",
    reason:
      `worker ${workerId} is not connected (silent for ${silence}, within the ` +
      `${Math.round(abandonAfterMs / 60000)}m abandon bound) — the agent may still be running there`,
  };
}

/**
 * Liveness of ANY session row. The single decision point: a `workerId` stamp
 * routes to remote evidence, everything else keeps the host pid rule verbatim.
 *
 * `remoteEvidence` is undefined when the caller could not obtain fleet state at
 * all (a probe threw). That is the purest `unknown` there is — fail HOLD.
 */
export function classifySessionLiveness(
  row: { pid: number | null; workerId: string | null },
  deps: {
    checkPid: (pid: number) => boolean;
    remoteEvidence?: RemoteEvidence;
    nowMs?: number;
    abandonAfterMs?: number;
    lastEvidenceAt?: string | null;
  },
): LivenessVerdict {
  if (row.workerId) {
    if (!deps.remoteEvidence) {
      return {
        liveness: "unknown",
        reason: `session runs on fleet worker ${row.workerId} and its state could not be read — holding`,
      };
    }
    return classifyRemoteSessionLiveness(deps.remoteEvidence, {
      workerId: row.workerId,
      nowMs: deps.nowMs,
      abandonAfterMs: deps.abandonAfterMs,
    });
  }
  if (row.pid == null) {
    return { liveness: "dead", reason: "pid=null (no process was tracked)" };
  }
  let alive = false;
  try {
    alive = deps.checkPid(row.pid);
  } catch {
    alive = false;
  }
  return alive
    ? { liveness: "alive", reason: `pid=${row.pid} is alive` }
    : { liveness: "dead", reason: `pid=${row.pid} is dead` };
}

/** Read the fleet evidence for one remote session. Never throws. */
export async function readRemoteEvidence(
  workerId: string,
  fallbackEvidenceAt: string | null,
  database: Database = realDb,
): Promise<RemoteEvidence | undefined> {
  try {
    const worker = await getWorkerById(workerId, database);
    // Imported lazily: worker-fleet.service constructs the remote agent service, which
    // imports this module for its abandon bound. A static import here would close that
    // cycle for no benefit — the fleet is only needed when a probe actually runs.
    const { getWorkerFleet } = await import("./worker-fleet.service.js");
    const connected = getWorkerFleet(database).connections.isConnected(workerId);
    return {
      workerExists: Boolean(worker),
      workerConnected: connected,
      lastEvidenceAt: worker?.lastHeartbeatAt ?? fallbackEvidenceAt,
    };
  } catch (err) {
    console.error(`[liveness] could not read fleet state for worker ${workerId}`, err);
    return undefined;
  }
}

/**
 * The remote half of the decision, for reconcilers that hold a row and a DB.
 * Returns `unknown` (hold) whenever the board cannot see enough to be sure.
 */
export async function probeRemoteSessionLiveness(
  row: { workerId: string; startedAt?: string | null },
  database: Database = realDb,
  opts: { nowMs?: number; abandonAfterMs?: number } = {},
): Promise<LivenessVerdict> {
  const evidence = await readRemoteEvidence(row.workerId, row.startedAt ?? null, database);
  return classifySessionLiveness(
    { pid: null, workerId: row.workerId },
    { checkPid: () => false, remoteEvidence: evidence, nowMs: opts.nowMs, abandonAfterMs: opts.abandonAfterMs },
  );
}

/**
 * The abandon bound expressed against the heartbeat window, for callers that
 * want the shortest defensible hold rather than the default 30 minutes. A hold
 * shorter than the heartbeat-stale window would give up before the board's own
 * "is this worker online?" answer has even flipped.
 */
export const MIN_REMOTE_HOLD_MS = WORKER_HEARTBEAT_STALE_MS;
