import type { AgentLaunchRequest } from "./agent-dispatch.service.js";
import { resolveEffectivePrompt } from "./agent-provider/context-files-prompt.js";
import { buildRemoteLaunchSpec } from "./remote-launch-spec.js";
import { buildRemoteContextFiles } from "./remote-context-files.js";
import {
  REMOTE_BOARD_TOOLS,
  buildRemoteMcpConfigFile,
  getFleetMcpBridge,
  providerNeedsMcpTokenEnv,
  providerSupportsRemoteMcp,
  remoteMcpConfigArgs,
} from "./fleet-mcp-bridge.service.js";
import { TICKET_CONTEXT_FILENAME, announceRemoteBoardTools } from "@agentic-kanban/shared/lib/ticket-context";
// Remote agent execution over a fleet worker's WebSocket (epic #1, phase 1c #5).
//
// Implements the AgentExecutionService seam (phase 0): `launch` builds the SAME
// provider launch config the host path builds, but instead of spawning it ships
// a serializable WorkerLaunchSpec to the placed worker as an `assign`. The
// worker streams back events shaped exactly like AgentOutputEvent, which are
// fed to the session's normal onOutput callback — so broadcast, DB persistence
// and exit classification run unchanged. Phase 1c is same-machine: the spec's
// cwd is the board-local worktree path.
//
// The spec env is an ALLOWLISTED projection of the host env (#244,
// lib/remote-spec-env.ts) — never a copy of the board's process.env and never
// the selected profile's credentials. The worker merges it over its OWN
// environment, so its local agent login and paths win (decision 012).
//
// Failure contract:
//  - assign not deliverable (worker vanished between placement and launch):
//    launch THROWS — the dispatch proxy catches and re-launches on the host.
//  - a LAUNCH failure discovered after `launch` returned (the git-transport path
//    resolves its prerequisites asynchronously, so it cannot throw; or the worker
//    answers `assign_failed`): reported to `onDeferredLaunchFailure`, so the DISPATCH
//    proxy applies the #245 rule — host relaunch, or a refusal that names itself one
//    (#751). Only with no hook present does it degrade to a synthesized exit(1).
//  - worker socket lost mid-session: the worker keeps the agent running, so the
//    board HOLDS. Past the reconnect grace the session is marked DETACHED and the
//    hold is reported into the transcript; it is finalized only when the abandon
//    bound (REMOTE_SESSION_ABANDON_MS) passes with no reconnect. A reconnect
//    re-adopts it. See the disconnect handler for why 60s of silence is not death
//    (#746).
//  - worker reconnects and no longer LISTS a session it was running: the exit can
//    never arrive (the worker's pending-result queue is in-memory), so the session
//    is finalized — but only after any pushed result is landed. See onHello.

import { buildAgentLaunchConfig } from "./agent-provider.js";
import { resolveLaunchPorts, buildAgentSpawnEnv, resolveAgentHangTimeoutMs } from "../lib/agent-launch-env.js";
import { buildRemoteSpecEnv } from "../lib/remote-spec-env.js";
import { resolveWorktreeDevPorts } from "./worktree-ports.js";
import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import { updateSessionWorkerId, getSessionLiveness } from "../repositories/worker.repository.js";
import type { AgentExecutionService, AgentHandle, DeferredLaunchFailure } from "./agent-dispatch.service.js";
import type { AgentOutputCallback } from "./agent.service.js";
import { classifyAssignFailure, type WorkerConnectionManager } from "./worker-connection.service.js";
import { ensureGitHttpServer } from "./git-http.service.js";
import { syncIncomingBranch, clearIncomingRef, incomingRefFor } from "./worker-remote-sync.service.js";
import { listAgentSkills } from "../repositories/agent-skill.repository.js";
import { REMOTE_SESSION_ABANDON_MS } from "./remote-session-liveness.js";
import { WORKER_HEARTBEAT_STALE_MS } from "./worker-registry.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { getProjectByRepoPath } from "../repositories/project.repository.js";
import { createRemoteSessionEventRecorder } from "./agent-remote-events.js";
import type { WorkerRepoOpKind, WorkerRepoOpResult } from "@agentic-kanban/shared/lib/worker-protocol";

/**
 * How long a disconnected worker may be silent before the board REPORTS the gap.
 *
 * Was 60s, and expiry FAILED every session on that worker with a synthesized
 * exit(1) while the agent was still running there — confirmed live. 60s is shorter
 * than the worker daemon's own supervisor backoff (up to 30s) plus a reconnect, and
 * shorter than the board's own `WORKER_HEARTBEAT_STALE_MS` (90s) window for calling
 * a worker offline: the board gave up before its own definition of "offline" had
 * even triggered. Two heartbeat windows is the shortest defensible value (#746).
 *
 * Expiry no longer finalizes anything — it marks the session detached and says so.
 */
export const WORKER_RECONNECT_GRACE_MS = 2 * WORKER_HEARTBEAT_STALE_MS;

/**
 * How long after an `assign` a hello may omit the session without that meaning
 * anything (#746). A worker lists PROVISIONING sessions too
 * (`worker-agent-runner.runningSessionIds`), so the only window in which a live
 * session is legitimately absent from a hello is between the board's `send(assign)`
 * and the worker registering it — sub-second in practice. It is real though: a
 * reconnect racing a fresh assign made the board declare a session it had just
 * dispatched "lost" and fail it, which an e2e run caught immediately.
 */
export const WORKER_ASSIGN_SETTLE_MS = 30 * 1000;

interface RemoteSession {
  workerId: string;
  onOutput: AgentOutputCallback;
  stdinOpen: boolean;
  /** Set for git-transport sessions: sync the pushed branch back before exit. */
  repo?: RemoteSessionRepo;
  /**
   * The dispatch proxy's late-launch-failure hook (#751). Held per session because
   * `assign_failed` arrives on the manager's message channel, long after `launch`
   * returned, and a launch failure must reach the proxy's placement rule rather than
   * being flattened into an exit code here.
   */
  onDeferredLaunchFailure?: (failure: DeferredLaunchFailure) => void;
  /** Has this worker ever spoken about this session? Positive proof it took the assign. */
  observed?: boolean;
  /** A deferred "is this really lost?" re-check, armed by a hello inside the settle window. */
  lostCheckTimer?: ReturnType<typeof setTimeout>;
  /**
   * Epoch ms at which the board stopped being able to see this session (the
   * reconnect grace expired). Non-null means DETACHED: held, reported, not
   * finalized. Cleared on reconnect.
   */
  detachedSinceMs?: number;
}

/**
 * What the board knows about a git-transport session's repo.
 *
 * `projectId` was added for #783/#784: a mid-session repo operation needs a FRESH scoped
 * git token, and `issueToken` is scoped by project. It is optional because a session
 * ADOPTED after a board restart (#745) has only the path — see `resolveOpAuth`, which
 * recovers the project from `repoPath` rather than guessing.
 */
export interface RemoteSessionRepo {
  repoPath: string;
  branch: string;
  projectId?: string;
  incomingRef?: string;
}

/** How a board-initiated repo operation on a live remote session ended (#783, #784). */
export type RemoteRepoOpOutcome =
  | { ok: true; status: WorkerRepoOpResult["status"]; sha?: string }
  | { ok: false; status: WorkerRepoOpResult["status"] | "timeout" | "not-tracked" | "undeliverable"; error: string };

/**
 * The remote execution service. A superset of `AgentExecutionService`: a remote
 * session outlives the board process, so it also needs to be ADOPTED back (#745).
 */
export interface RemoteAgentService extends AgentExecutionService {
  adoptSession(params: {
    sessionId: string;
    workerId: string;
    onOutput: AgentOutputCallback;
    repo?: RemoteSessionRepo;
  }): void;
  /** Session ids this process currently tracks (live or detached). */
  trackedSessionIds(): string[];
  /**
   * What this process tracks about a session, for callers that must know whether it is
   * remote AND whether it runs over git transport before acting (#783, #784). A
   * filesystem-sharing worker has no `repo`: it works in the board's own worktree, so
   * there is nothing to sync and nothing to push.
   */
  remoteSessionInfo(sessionId: string): { workerId: string; repo?: RemoteSessionRepo } | undefined;
  /**
   * Every session this process is running over GIT TRANSPORT right now (#790).
   *
   * The board's copy of such a branch is the base tip until something lands the worker's
   * push, so any reader computing numbers from the board-side worktree is reading a zero
   * that is not the truth. This is the cheap, synchronous way to ASK — no git, no push, no
   * DB — which is what makes it usable from the board's hot per-card paths, where #784's
   * on-demand landing deliberately is not.
   *
   * Filesystem-sharing workers are absent by construction: they have no `repo`, because
   * they write into the board's own worktree and there is nothing unlanded.
   */
  remoteGitTransportSessions(): Array<{ sessionId: string; workerId: string; branch: string; repoPath: string }>;
  /**
   * Ask the worker to fast-forward its live checkout to the board's branch tip (#783) or
   * to push its current HEAD to the incoming ref (#784), and WAIT for the answer.
   *
   * Bounded: an unanswered request resolves `{ok:false, status:"timeout"}` rather than
   * hanging, because the caller refuses a turn on it.
   */
  requestRepoOp(
    sessionId: string,
    op: WorkerRepoOpKind,
    opts?: { timeoutMs?: number },
  ): Promise<RemoteRepoOpOutcome>;
}

/**
 * How long the board waits for a worker's answer to a repo operation (#783).
 *
 * A fetch + fast-forward of one branch over the board's own git transport, so seconds in
 * the normal case; the ceiling exists for the worker that never answers at all (a build
 * that predates these messages drops them as unknown, exactly as this protocol module
 * intends). The refusal it produces names that possibility.
 */
export const REPO_OP_TIMEOUT_MS = 60 * 1000;

export function createRemoteAgentService(
  manager: WorkerConnectionManager,
  database: Database = realDb,
  opts?: { reconnectGraceMs?: number; abandonMs?: number; assignSettleMs?: number },
): RemoteAgentService {
  const sessions = new Map<string, RemoteSession>();
  const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const abandonTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const graceMs = opts?.reconnectGraceMs ?? WORKER_RECONNECT_GRACE_MS;
  const abandonMs = Math.max(opts?.abandonMs ?? REMOTE_SESSION_ABANDON_MS, graceMs);
  const assignSettleMs = opts?.assignSettleMs ?? WORKER_ASSIGN_SETTLE_MS;
  // #769: the board-tool bridge for remote builders. Shared per database with the fleet
  // listener that serves it, so the token this path mints is the one that listener resolves.
  const fleetMcp = getFleetMcpBridge(database);
  /**
   * Repo operations awaiting a worker's answer, by `requestId` (#783, #784).
   *
   * Correlated by request rather than by session because a diff request and a pre-turn
   * sync can be in flight for the same session at the same time, and resolving the wrong
   * one would report a push as a sync.
   */
  const pendingRepoOps = new Map<
    string,
    { sessionId: string; op: WorkerRepoOpKind; settle: (outcome: RemoteRepoOpOutcome) => void }
  >();
  let repoOpSeq = 0;

  // #801 — the assignment's opening and closing rows. A separate module: see its header.
  const { noteAssigned, noteSessionExit } = createRemoteSessionEventRecorder(database);

  function finishSession(sessionId: string, session: RemoteSession, stderr: string, exitCode: number | null): void {
    sessions.delete(sessionId);
    noteSessionExit(sessionId, session, exitCode, "finalized without landing");
    // #769: the board-tool token dies with its assignment. Unlike the git token it is NOT
    // persisted, so this (and revokeWorker) is the whole of its revocation story.
    fleetMcp.revokeSessionTokens(sessionId);
    try {
      session.onOutput({ type: "stderr", sessionId, data: stderr });
      session.onOutput({ type: "exit", sessionId, exitCode });
    } catch (err) {
      console.error(`[agent-remote] output callback error: sessionId=${sessionId}`, err);
    }
  }

  /**
   * Land whatever the worker pushed, then finalize. Used by the normal exit path AND
   * by every give-up path (#746): a session the board stops waiting for may still
   * have PUSHED its result, and orphaning that work in the incoming ref is the most
   * expensive possible outcome. Landing goes through the #743 path
   * (`syncIncomingBranch`) — never a second, private one.
   *
   * A sync failure downgrades the exit code, so a session whose work did not land is
   * never recorded as a clean success.
   */
  async function landAndFinish(
    sessionId: string,
    session: RemoteSession,
    reportedExitCode: number | null,
  ): Promise<void> {
    sessions.delete(sessionId);
    fleetMcp.revokeSessionTokens(sessionId);
    let exitCode = reportedExitCode;
    if (session.repo) {
      try {
        const result = await syncIncomingBranch(session.repo.repoPath, session.repo.branch);
        if (result.ok) {
          console.log(`[agent-remote] synced ${session.repo.branch} (${result.status}) for session ${sessionId}`);
          await clearIncomingRef(session.repo.repoPath, session.repo.branch).catch(() => {});
        } else if (result.status === "missing" && exitCode !== 0) {
          // The agent failed before producing anything to push — nothing to sync.
          console.warn(`[agent-remote] no incoming ref for failed session ${sessionId}; nothing to sync`);
        } else {
          session.onOutput({
            type: "stderr",
            sessionId,
            data: `Worker result could not be landed on ${session.repo.branch}: ${result.error}`,
          });
          exitCode = exitCode === 0 || exitCode === null ? 1 : exitCode;
        }
      } catch (err) {
        session.onOutput({ type: "stderr", sessionId, data: `Branch sync failed: ${errorMessage(err)}` });
        exitCode = exitCode === 0 || exitCode === null ? 1 : exitCode;
      }
    }
    noteSessionExit(sessionId, session, exitCode, "landed and finalized");
    try {
      session.onOutput({ type: "exit", sessionId, exitCode });
    } catch (err) {
      console.error(`[agent-remote] exit callback error: sessionId=${sessionId}`, err);
    }
  }

  /** Report into the session's own transcript, so a hold is visible where the run is. */
  function report(sessionId: string, session: RemoteSession, text: string): void {
    try {
      session.onOutput({ type: "stderr", sessionId, data: text });
    } catch (err) {
      console.error(`[agent-remote] output callback error: sessionId=${sessionId}`, err);
    }
  }

  /**
   * The worker is up and does not have this session: its exit can never arrive (the
   * worker's pending-result queue is in-memory and does not survive a daemon restart,
   * and the pipe to an orphaned child died with the old daemon). Land anything it
   * pushed, then finalize non-zero — the board never observed the agent's own verdict,
   * so recording it as a clean success would be worse than a visible failure (#746).
   */
  function loseSession(sessionId: string, workerId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (session.lostCheckTimer) clearTimeout(session.lostCheckTimer);
    console.warn(
      `[agent-remote] worker ${workerId} is connected but does not list session ${sessionId} ` +
        `(daemon restart or crash); its exit can never arrive — landing any pushed result and failing it`,
    );
    report(
      sessionId,
      session,
      `Fleet worker ${workerId} reconnected without this session: its agent is gone and no exit can ` +
        `arrive (the worker's pending-result queue does not survive a daemon restart). Any result it ` +
        `pushed is being landed on the branch before this session is closed.`,
    );
    void landAndFinish(sessionId, session, 1);
  }

  function clearWorkerTimers(workerId: string): void {
    const grace = disconnectTimers.get(workerId);
    if (grace) { clearTimeout(grace); disconnectTimers.delete(workerId); }
    const abandon = abandonTimers.get(workerId);
    if (abandon) { clearTimeout(abandon); abandonTimers.delete(workerId); }
  }

  manager.onMessage((workerId, message) => {
    if (message.type === "event") {
      const session = sessions.get(message.event.sessionId);
      if (!session || session.workerId !== workerId) return;
      // The worker has spoken about this session, so a later hello that omits it is
      // information rather than a race (see WORKER_ASSIGN_SETTLE_MS).
      session.observed = true;
      if (session.lostCheckTimer) {
        clearTimeout(session.lostCheckTimer);
        session.lostCheckTimer = undefined;
      }
      if (message.event.type !== "exit") {
        try {
          session.onOutput(message.event);
        } catch (err) {
          console.error(`[agent-remote] output callback error: sessionId=${message.event.sessionId}`, err);
        }
        return;
      }
      // Exit: for a git-transport session the worker has already pushed to the
      // incoming ref, so land it on the real branch BEFORE the board's exit
      // handling runs — review/merge must never see a branch that has not
      // arrived. A sync failure downgrades the exit code so a session whose
      // work did not land is never recorded as a clean success.
      const sessionId = message.event.sessionId;
      const exitEvent = message.event;
      sessions.delete(sessionId);
      if (!session.repo) {
        try {
          session.onOutput(exitEvent);
        } catch (err) {
          console.error(`[agent-remote] output callback error: sessionId=${sessionId}`, err);
        }
        return;
      }
      void landAndFinish(sessionId, session, exitEvent.exitCode ?? null);
      return;
    }
    if (message.type === "hello") {
      // A worker that reconnects after a board restart announces sessions this
      // process has no memory of. The original rule stopped all of them, on the
      // assumption that the startup sweep had already finalized their rows and the
      // agents were therefore unreachable zombies.
      //
      // That assumption is not always true, and when it is wrong the cost is high.
      // Observed: a board restart mid-run, the worker reconnected 54s later, and the
      // board answered its hello by killing an agent that had been working for 65
      // seconds — silently, from the board's side. The kill also pre-empted the
      // push, so the work was not recoverable from the incoming ref either.
      //
      // So ask the DB instead of assuming. A row that is still `running` on THIS
      // worker is sanctioned work in progress: leave it alone. It finishes, pushes
      // to its incoming ref, and the startup sweep lands it — the recovery path
      // decision 012 already specifies. Only a session the board has genuinely
      // finished with (terminal row, or no row at all) is the zombie the stop was
      // written for.
      //
      // NOTE: leaving it running is not the same as adopting it — but adoption now
      // exists (#745). `startup/remote-session-readoption.ts` runs before the pid
      // sweep and rebuilds the output callback for every session this board left on a
      // worker, so in the normal restart case a hello arrives AFTER adoption and this
      // branch is not even reached. It still is when the board never held the row
      // (adopted by a different board, or a row that predates the sweep), and there
      // the old rule stands: leave it alone, and let the incoming-ref sweep land it.
      // The REVERSE direction (#746): the board tracks a session on THIS worker that
      // the worker's own hello does not list. Genuinely ambiguous — the daemon may
      // have restarted (its children killed) or crashed (children orphaned, their
      // pipes gone either way).
      //
      // DECIDED: finalize it, after landing anything it pushed. A hello is POSITIVE
      // information — the daemon is up and has enumerated what it holds — and the
      // exit can no longer reach us in ANY of the branches: the worker's
      // pending-result queue is in-memory (`PENDING_QUEUE_CAP`, lost on daemon
      // restart) and the pipe to an orphaned child died with the old daemon. So
      // holding here would hang the workspace forever, which is the bug this ticket
      // names. It exits non-zero even when the branch landed cleanly: the board never
      // saw the agent's own verdict, and recording an unobserved run as a clean
      // success is the one outcome worse than a visible failure.
      const listed = new Set(message.runningSessionIds);
      const missing = [...sessions.entries()].filter(([id, sess]) => sess.workerId === workerId && !listed.has(id));
      for (const [sessionId, session] of missing) {
        if (session.observed) {
          loseSession(sessionId, workerId);
          continue;
        }
        // Never observed: this hello may simply have crossed a fresh assign. Re-check
        // once the settle window has passed instead of guessing either way — skipping
        // outright would reinstate the infinite hang for an ADOPTED session (which this
        // process has never seen an event for), and acting now fails live work.
        if (session.lostCheckTimer) continue;
        console.warn(
          `[agent-remote] worker ${workerId} does not list session ${sessionId}, which this process has ` +
            `not yet seen it speak about; re-checking in ${Math.round(assignSettleMs / 1000)}s`,
        );
        const timer = setTimeout(() => {
          const current = sessions.get(sessionId);
          if (!current || current.workerId !== workerId) return;
          current.lostCheckTimer = undefined;
          if (current.observed) return;
          loseSession(sessionId, workerId);
        }, assignSettleMs);
        if (timer.unref) timer.unref();
        session.lostCheckTimer = timer;
      }

      const unknown = message.runningSessionIds.filter((id) => !sessions.has(id));
      if (unknown.length === 0) return;
      void (async () => {
        for (const sessionId of unknown) {
          let live: { status: string; workerId: string | null } | null = null;
          try {
            live = await getSessionLiveness(sessionId, database);
          } catch (err) {
            // Fail SAFE: if we cannot tell, do not kill. A stray agent is cheaper
            // than destroying work we were unable to ask about.
            console.error(
              `[agent-remote] could not check session ${sessionId} reported by worker ${workerId}; leaving it running`,
              err,
            );
            continue;
          }
          if (live && live.status === "running" && live.workerId === workerId) {
            console.warn(
              `[agent-remote] worker ${workerId} reports session ${sessionId}, which this process does not track ` +
                `but the DB still has running on that worker — leaving it alone. Its output is not being streamed; ` +
                `its result will land from the incoming ref on the next startup sweep.`,
            );
            continue;
          }
          const why = !live ? "no session row" : `row is ${live.status}` + (live.workerId === workerId ? "" : " on another worker");
          console.warn(
            `[agent-remote] worker ${workerId} reports unknown session ${sessionId} (${why}); stopping the orphan`,
          );
          manager.send(workerId, { type: "stop", sessionId });
        }
      })();
      return;
    }
    if (message.type === "repo_op_result") {
      const pending = pendingRepoOps.get(message.result.requestId);
      // An answer to a request this process never made (or already timed out) is dropped:
      // the caller has been told, and re-resolving would report a stale outcome as fresh.
      if (!pending) return;
      pendingRepoOps.delete(message.result.requestId);
      const { ok, status, sha, error } = message.result;
      pending.settle(
        ok
          ? { ok: true, status, ...(sha ? { sha } : {}) }
          : {
              ok: false,
              status,
              error: error ?? `worker ${workerId} refused the ${pending.op} with status ${status}`,
            },
      );
      return;
    }
    if (message.type === "assign_failed") {
      const session = sessions.get(message.sessionId);
      if (!session || session.workerId !== workerId) return;
      // A worker's refusal is a LAUNCH failure, not a run that exited 1 — and the kind
      // matters: a capacity refusal means another worker would have taken it, a
      // provisioning failure means THIS worker's checkout is broken. Report it to the
      // dispatch proxy, which owns the host-fallback/strict decision (#751); only
      // synthesize an exit when nobody is listening.
      const kind = classifyAssignFailure(message.error);
      console.warn(`[agent-remote] assign failed on worker ${workerId} (${kind}): ${message.error}`);
      if (session.onDeferredLaunchFailure) {
        sessions.delete(message.sessionId);
        session.onDeferredLaunchFailure({ kind, reason: message.error });
        return;
      }
      finishSession(message.sessionId, session, `Worker could not start the agent: ${message.error}`, 1);
    }
  });

  // A lost socket is a lost VIEW, not a dead agent (#746). The old rule synthesized
  // exit(1) for every session on the worker after 60s — destroying a run the worker was
  // still executing, and pre-empting its push. So the gap has two bounds and they mean
  // different things:
  //
  //   graceMs   -> REPORT. The session is marked DETACHED and the hold is written into
  //                its own transcript. Nothing is finalized; a reconnect re-adopts it.
  //   abandonMs -> GIVE UP. Only now is the session finalized, and only after landing
  //                anything the worker managed to push.
  manager.onDisconnect((workerId) => {
    const affected = [...sessions.entries()].filter(([, s]) => s.workerId === workerId);
    if (affected.length === 0) return;
    console.warn(
      `[agent-remote] worker ${workerId} disconnected with ${affected.length} session(s); ` +
      `holding — reporting at ${Math.round(graceMs / 1000)}s, giving up at ${Math.round(abandonMs / 60000)}m`,
    );
    clearWorkerTimers(workerId);

    const graceTimer = setTimeout(() => {
      disconnectTimers.delete(workerId);
      const detachedAt = Date.now();
      for (const [sessionId, session] of sessions.entries()) {
        if (session.workerId !== workerId) continue;
        session.detachedSinceMs = detachedAt;
        console.warn(
          `[agent-remote] worker ${workerId} has not reconnected in ${Math.round(graceMs / 1000)}s; ` +
            `session ${sessionId} is DETACHED (held, not failed) until ${Math.round(abandonMs / 60000)}m`,
        );
        report(
          sessionId,
          session,
          `Lost the connection to fleet worker ${workerId} ${Math.round(graceMs / 1000)}s ago. The agent is ` +
            `most likely still running there; the board simply cannot see it, so live output is dropped from ` +
            `here on. This session is HELD, not failed — it resumes if the worker reconnects within ` +
            `${Math.round(abandonMs / 60000)} minutes.`,
        );
      }
    }, graceMs);
    if (graceTimer.unref) graceTimer.unref();
    disconnectTimers.set(workerId, graceTimer);

    const abandonTimer = setTimeout(() => {
      abandonTimers.delete(workerId);
      for (const [sessionId, session] of [...sessions.entries()]) {
        if (session.workerId !== workerId) continue;
        console.error(
          `[agent-remote] worker ${workerId} silent for ${Math.round(abandonMs / 60000)}m; abandoning session ${sessionId}`,
        );
        report(
          sessionId,
          session,
          `Fleet worker ${workerId} has been unreachable for ${Math.round(abandonMs / 60000)} minutes. Giving ` +
            `up on this session. If the worker pushed a result before it vanished it is being landed on the ` +
            `branch now; otherwise its work remains only in the worker's own clone.`,
        );
        void landAndFinish(sessionId, session, 1);
      }
    }, abandonMs);
    if (abandonTimer.unref) abandonTimer.unref();
    abandonTimers.set(workerId, abandonTimer);
  });

  manager.onConnect((workerId) => {
    const held = disconnectTimers.has(workerId) || abandonTimers.has(workerId);
    clearWorkerTimers(workerId);
    if (!held) return;
    const readopted: string[] = [];
    for (const [sessionId, session] of sessions.entries()) {
      if (session.workerId !== workerId) continue;
      if (session.detachedSinceMs !== undefined) readopted.push(sessionId);
      session.detachedSinceMs = undefined;
    }
    if (readopted.length === 0) {
      console.log(`[agent-remote] worker ${workerId} reconnected within grace; sessions continue`);
      return;
    }
    console.log(
      `[agent-remote] worker ${workerId} reconnected; re-adopting detached session(s) ${readopted.join(", ")} — ` +
        `their callbacks were never torn down, so streaming resumes`,
    );
    for (const sessionId of readopted) {
      const session = sessions.get(sessionId);
      if (session) report(sessionId, session, `Fleet worker ${workerId} reconnected; this session is live again.`);
    }
  });

  function launch(request: AgentLaunchRequest): AgentHandle {
    // #524: one object instead of twenty positional parameters. `_containerProvision`
    // stays unread here — a remote worker provisions its own environment — and that is
    // now visible as an unused FIELD rather than a placeholder in argument position 19.
    const {
      worktreePath, sessionId, prompt, agentArgs, onOutput,
      providerSessionId, agentCommand, keepAlive, permissionPromptTool,
      planMode, provider, profile, extraEnv, skipPermissions,
      model, contextFiles, systemInstructions, placement, onDeferredLaunchFailure,
    } = request;
    if (placement?.kind !== "remote") {
      throw new Error("remote agent service requires a remote placement");
    }
    const workerId = placement.workerId;

    // #524: codex has no channel for contextFiles other than the prompt, and this path
    // used to send the raw one — so a codex builder on a fleet worker ran with NO ticket
    // context. Same helper the host uses, so the two cannot diverge again.
    const effectivePrompt = resolveEffectivePrompt(prompt, provider, contextFiles);
    const config = buildAgentLaunchConfig({
      agentArgs,
      providerSessionId,
      agentCommand,
      profile,
      model,
      systemInstructions,
      keepAlive,
      permissionPromptTool,
      planMode,
      provider,
      prompt: effectivePrompt,
      contextFiles,
      skipPermissions,
    });
    const devPorts = resolveWorktreeDevPorts(worktreePath);
    const ports = resolveLaunchPorts(
      process.env,
      devPorts ? { serverPort: String(devPorts.serverPort), clientPort: String(devPorts.clientPort) } : null,
    );
    const envWithUndefined = buildAgentSpawnEnv({
      spawnEnv: config.env,
      ports,
      serverPid: String(process.pid),
      protectedPidsEnv: process.env.KANBAN_PROTECTED_PIDS,
      sessionId,
      worktreePath,
      extraEnv,
    });
    // #244: a remote spec crosses a machine boundary, so it carries an ALLOWLISTED
    // projection of the host env — never the board's process.env or the selected
    // profile's credentials. The worker merges this over its own environment, so
    // its local login and paths win (decision 012).
    const env = buildRemoteSpecEnv({
      env: envWithUndefined,
      sharesFilesystem: !placement.repo,
      worktreePath,
    });
    const stdinPrompt = config.promptPrefix ? `${config.promptPrefix}\n\n${prompt}` : prompt;

    // #244's sibling, generalized in #747: the ENV is projected for a cross-machine spec,
    // but the COMMAND and ARGS were built for the BOARD's machine — an absolute
    // `claude.exe`, a `useShell` derived from the board's own platform, and args naming
    // board-host paths (`--mcp-config` in this machine's tmpdir, `--settings` in this
    // machine's home). A true-remote spec therefore carries INTENT and the worker resolves
    // its own executable; see remote-launch-spec.ts for the full rationale. A
    // same-filesystem worker keeps everything verbatim, exactly as it keeps host paths in
    // env.
    const isTrueRemote = Boolean(placement.repo);
    const spec = buildRemoteLaunchSpec({
      config,
      env,
      cwd: worktreePath,
      stdinPrompt,
      // Same policy as a host launch: mock agents are deterministic and
      // short-lived, everything else gets the silence watchdog.
      hangTimeoutMs: config.isMockAgent ? 0 : resolveAgentHangTimeoutMs(),
      provider,
      trueRemote: isTrueRemote,
      // An explicit agentCommand (or KANBAN_AGENT_COMMAND, which isMockAgent reflects) is
      // the operator's exact command, not a provider's platform guess — it travels as-is.
      explicitCommand: Boolean(agentCommand) || Boolean(config.isMockAgent),
    });

    // Same-machine dispatch (no repo in the placement): the worker shares this
    // filesystem, so assign directly. Git transport needs the git-http listener
    // and the skill payload, which are async — assign after they resolve, and
    // report a failure the way an unreachable worker would.
    if (!placement.repo) {
      if (!manager.send(workerId, { type: "assign", sessionId, spec })) {
        throw new Error(`fleet worker ${workerId} is not connected`);
      }
      // #801 — recorded only once the assign is actually ON THE WIRE. An event written
      // before the send would claim an assignment that a `false` return means never
      // happened, and a timeline that lies about what a worker was given is worse than
      // no timeline.
      noteAssigned(sessionId, workerId, { transport: "shared-filesystem" });
    } else {
      const repo = placement.repo;
      void (async () => {
        try {
          const git = await ensureGitHttpServer(database);
          const skillRows = await listAgentSkills(repo.projectId, false, database).catch(() => []);
          const incomingRef = incomingRefFor(repo.branch);
          // #247/#246: the token is scoped to THIS worker, THIS project and THIS
          // incoming ref — not a board-wide credential for every repo — and it is
          // dropped when the worker is revoked.
          const gitToken = git.issueToken({ workerId, projectId: repo.projectId, incomingRef });
          // #769: board TOOLS for a remote builder — the second half of #749. A per-assignment
          // token on the fleet listener's allowlisted MCP bridge, delivered as a config file in
          // the checkout (never in argv, where a process listing would show it) plus the provider
          // flag that loads it. Same scoping rules as the git token above: one worker, one
          // project, one session; expiring; dropped on revoke and when the session ends.
          const remoteContextFiles = buildRemoteContextFiles(contextFiles);
          const mcpArgs: string[] = [];
          const mcpAssignment = providerSupportsRemoteMcp(provider)
            ? fleetMcp.prepareAssignment({ workerId, projectId: repo.projectId, sessionId })
            : null;
          // #799 — codex takes its config through argv (`-c mcp_servers...`) and its TOKEN
          // through the worker's own environment, so it gets no config file and instead sets
          // `boardMcpToken` below. claude/copilot keep the file channel #769 built.
          const mcpTokenViaEnv = mcpAssignment !== null && providerNeedsMcpTokenEnv(provider);
          if (mcpAssignment) {
            if (!mcpTokenViaEnv) remoteContextFiles.push(buildRemoteMcpConfigFile(mcpAssignment));
            mcpArgs.push(...remoteMcpConfigArgs(provider, { url: mcpAssignment.url }));
            // The brief was retargeted to "no board tools here" while it was read (#749). That is
            // now false for this assignment, so the section is rewritten to name the tools that
            // actually work — instructions that describe the wrong environment are how an agent
            // wastes a session.
            for (const file of remoteContextFiles) {
              if (file.name !== TICKET_CONTEXT_FILENAME) continue;
              file.content = announceRemoteBoardTools(file.content, { boardTools: REMOTE_BOARD_TOOLS });
            }
          } else {
            console.log(
              `[agent-remote] no board MCP bridge for session ${sessionId} ` +
                `(provider=${provider ?? "claude"}, fleet listener ${fleetMcp.endpointPort() === null ? "not running" : "up"}) — ` +
                "the worker's brief keeps saying it has no board tools",
            );
          }
          const delivered = manager.send(workerId, {
            type: "assign",
            sessionId,
            spec: mcpArgs.length > 0 ? { ...spec, args: [...spec.args, ...mcpArgs] } : spec,
            repo: {
              projectId: repo.projectId,
              gitPort: git.port,
              gitToken,
              branch: repo.branch,
              baseBranch: repo.baseBranch,
              incomingRef,
              setupScript: repo.setupScript,
              // #749: the ticket-context file travels as CONTENT (the board's path names
              // nothing on the worker) and is retargeted for a machine with no board MCP.
              // #769 appends the MCP config file to the same channel when a bridge is offered.
              contextFiles: remoteContextFiles,
              ...(mcpTokenViaEnv && mcpAssignment ? { boardMcpToken: mcpAssignment.token } : {}),
              skills: skillRows
                .filter((s) => typeof s.prompt === "string" && s.prompt.trim().length > 0)
                .map((s) => ({ name: s.name, description: s.description ?? "", content: s.prompt })),
            },
          });
          if (!delivered) throw new Error(`fleet worker ${workerId} is not connected`);
          noteAssigned(sessionId, workerId, {
            transport: "git",
            branch: repo.branch,
            baseBranch: repo.baseBranch,
            projectId: repo.projectId,
            boardTools: mcpAssignment !== null,
          });
          console.log(`[agent-remote] git-transport assignment sent: sessionId=${sessionId} branch=${repo.branch}`);
        } catch (err) {
          const message = errorMessage(err);
          console.error(`[agent-remote] git-transport assignment failed: sessionId=${sessionId}: ${message}`);
          // This path CANNOT throw to the dispatch proxy — `launch` returned before the
          // git-http listener, skill payload and scoped token resolved. Reporting it as
          // a deferred launch failure is what restores the #245 contract here: a
          // non-strict project gets its host run instead of a failed session (#751).
          if (onDeferredLaunchFailure) {
            sessions.delete(sessionId);
            onDeferredLaunchFailure({ kind: "dispatch", reason: message });
            return;
          }
          const session = sessions.get(sessionId);
          if (session) finishSession(sessionId, session, `Could not dispatch to worker: ${message}`, 1);
        }
      })();
    }
    console.log(`[agent-remote] assigned session ${sessionId} to worker ${workerId} (command=${config.command})`);
    sessions.set(sessionId, {
      workerId,
      onOutput,
      stdinOpen: Boolean(config.keepStdinOpen && !config.suppressStdinPrompt),
      repo: placement.repo
        ? {
            repoPath: placement.repo.repoPath,
            branch: placement.repo.branch,
            // #783/#784: a mid-session sync or push needs a FRESH token, which is scoped
            // by project + incoming ref. Recorded here so the operation never has to
            // re-derive either from a path.
            projectId: placement.repo.projectId,
            incomingRef: incomingRefFor(placement.repo.branch),
          }
        : undefined,
      onDeferredLaunchFailure,
    });
    updateSessionWorkerId(sessionId, workerId, database)
      .catch((err) => console.error(`[agent-remote] failed to stamp session workerId: sessionId=${sessionId}`, err));
    return {};
  }

  function kill(sessionId: string): boolean {
    const session = sessions.get(sessionId);
    if (!session) return false;
    // The exit event from the worker finalizes the session; if the worker is
    // gone the disconnect grace path does. Either way the mapping stays until
    // an exit arrives so late output is not misrouted.
    return manager.send(session.workerId, { type: "stop", sessionId });
  }

  function sendInput(sessionId: string, content: string): boolean {
    const session = sessions.get(sessionId);
    if (!session || !session.stdinOpen) return false;
    return manager.send(session.workerId, {
      type: "input",
      sessionId,
      data: JSON.stringify({ type: "user", content }),
    });
  }

  function closeStdin(sessionId: string): boolean {
    const session = sessions.get(sessionId);
    if (!session) return false;
    session.stdinOpen = false;
    return manager.send(session.workerId, { type: "close_stdin", sessionId });
  }

  function isStdinOpen(sessionId: string): boolean {
    return sessions.get(sessionId)?.stdinOpen === true;
  }

  function getProcess(sessionId: string): AgentHandle | undefined {
    return sessions.has(sessionId) ? {} : undefined;
  }

  function getPid(_sessionId: string): number | undefined {
    return undefined;
  }

  // NOTE on `worker-lost`: the abandon path does NOT report a deferred launch failure,
  // even though the kind exists. By then the agent has been RUNNING on the worker,
  // possibly for many minutes and possibly having pushed — a host relaunch would
  // duplicate work rather than recover a launch. `onDeferredLaunchFailure` is for
  // failures of the LAUNCH; a lost worker mid-run is finalized by the abandon bound
  // after landing whatever arrived (#746).

  /**
   * #746: this used to require a live socket, so a detached session read as DEAD and
   * the session-lifecycle's stale-session cleanup finalized it out from under a
   * running agent. While the board still TRACKS a session it has no evidence of
   * death: a missing socket is a missing view. The abandon timer is what ends a held
   * session, deliberately and with a reason.
   */
  function isPidAlive(sessionId: string): boolean {
    return sessions.has(sessionId);
  }

  /**
   * Re-adopt a session this process did not launch — the board restarted while the
   * worker kept running the agent (#745). Rebuilding the mapping is what makes the
   * worker's next event (and its exit) land through the NORMAL path, instead of being
   * dropped as "a session we do not track".
   */
  function adoptSession(params: {
    sessionId: string;
    workerId: string;
    onOutput: AgentOutputCallback;
    repo?: { repoPath: string; branch: string };
  }): void {
    if (sessions.has(params.sessionId)) return;
    sessions.set(params.sessionId, {
      workerId: params.workerId,
      onOutput: params.onOutput,
      // Stdin state does not survive a restart; a follow-up turn must relaunch.
      stdinOpen: false,
      repo: params.repo,
    });
    console.log(
      `[agent-remote] adopted session ${params.sessionId} on worker ${params.workerId} after a board restart`,
    );
  }

  function remoteSessionInfo(sessionId: string): { workerId: string; repo?: RemoteSessionRepo } | undefined {
    const session = sessions.get(sessionId);
    if (!session) return undefined;
    return { workerId: session.workerId, ...(session.repo ? { repo: session.repo } : {}) };
  }

  function remoteGitTransportSessions(): Array<{ sessionId: string; workerId: string; branch: string; repoPath: string }> {
    const out: Array<{ sessionId: string; workerId: string; branch: string; repoPath: string }> = [];
    for (const [sessionId, session] of sessions) {
      if (!session.repo) continue;
      out.push({ sessionId, workerId: session.workerId, branch: session.repo.branch, repoPath: session.repo.repoPath });
    }
    return out;
  }

  /**
   * The fresh, scoped git capability the worker needs for one repo operation (#783).
   *
   * Goes through the EXISTING `issueToken({workerId, projectId, incomingRef})` seam — the
   * same per-assignment scoping #247 established — rather than minting a wider credential
   * for the convenience of a mid-session call. Decision 012 is untouched: this is a git
   * capability for one ref, not an agent login.
   */
  async function resolveOpAuth(
    sessionId: string,
    session: RemoteSession,
    repo: RemoteSessionRepo,
  ): Promise<{ projectId: string; gitPort: number; gitToken: string; branch: string; incomingRef: string }> {
    // An ADOPTED session (#745) carries only the path, so the project is recovered from it
    // rather than guessed — git is the authority for the branch, the DB for the project.
    const projectId = repo.projectId ?? (await getProjectByRepoPath(repo.repoPath, database))?.id;
    if (!projectId) {
      throw new Error(
        `no project is registered at ${repo.repoPath}, so no scoped git token can be issued for session ${sessionId}`,
      );
    }
    const incomingRef = repo.incomingRef ?? incomingRefFor(repo.branch);
    const git = await ensureGitHttpServer(database);
    return {
      projectId,
      gitPort: git.port,
      gitToken: git.issueToken({ workerId: session.workerId, projectId, incomingRef }),
      branch: repo.branch,
      incomingRef,
    };
  }

  async function requestRepoOp(
    sessionId: string,
    op: WorkerRepoOpKind,
    opts?: { timeoutMs?: number },
  ): Promise<RemoteRepoOpOutcome> {
    const session = sessions.get(sessionId);
    if (!session) {
      return {
        ok: false,
        status: "not-tracked",
        error: `this board process does not track session ${sessionId} as remote`,
      };
    }
    if (!session.repo) {
      return {
        ok: false,
        status: "not-tracked",
        error: `session ${sessionId} runs on a filesystem-sharing worker, which has no checkout of its own`,
      };
    }
    let auth;
    try {
      auth = await resolveOpAuth(sessionId, session, session.repo);
    } catch (err) {
      return { ok: false, status: "error", error: errorMessage(err) };
    }
    const requestId = `${op}-${sessionId}-${++repoOpSeq}`;
    const timeoutMs = opts?.timeoutMs ?? REPO_OP_TIMEOUT_MS;
    return await new Promise<RemoteRepoOpOutcome>((resolve) => {
      let done = false;
      const settle = (outcome: RemoteRepoOpOutcome): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pendingRepoOps.delete(requestId);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        settle({
          ok: false,
          status: "timeout",
          error:
            `fleet worker ${session.workerId} did not answer the ${op} request within ` +
            `${Math.round(timeoutMs / 1000)}s — it may be busy, unreachable, or a build that ` +
            `predates the sync_repo/push_head messages (such a worker drops them silently)`,
        });
      }, timeoutMs);
      if (timer.unref) timer.unref();
      pendingRepoOps.set(requestId, { sessionId, op, settle });
      const delivered = manager.send(session.workerId, {
        type: op === "sync" ? "sync_repo" : "push_head",
        sessionId,
        requestId,
        auth,
      });
      if (!delivered) {
        settle({
          ok: false,
          status: "undeliverable",
          error: `fleet worker ${session.workerId} is not connected, so its checkout cannot be reached`,
        });
      }
    });
  }

  function trackedSessionIds(): string[] {
    return [...sessions.keys()];
  }

  return {
    launch, kill, sendInput, closeStdin, isStdinOpen, getProcess, getPid, isPidAlive,
    adoptSession, trackedSessionIds, remoteSessionInfo, remoteGitTransportSessions, requestRepoOp,
  };
}
