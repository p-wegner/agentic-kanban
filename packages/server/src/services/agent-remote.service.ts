import type { AgentLaunchRequest } from "./agent-dispatch.service.js";
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

import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import { updateSessionWorkerId } from "../repositories/worker.repository.js";
import { recordUndeliveredResult } from "./agent-remote-undelivered.js";
import type { AgentExecutionService, AgentHandle, DeferredLaunchFailure } from "./agent-dispatch.service.js";
import type { AgentOutputCallback } from "./agent.service.js";
import { classifyAssignFailure, type WorkerConnectionManager } from "./worker-connection.service.js";
import { incomingRefFor } from "./worker-remote-sync.service.js";
import { REMOTE_SESSION_ABANDON_MS } from "./remote-session-liveness.js";
import { WORKER_HEARTBEAT_STALE_MS } from "./worker-registry.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { WorkerPhaseTimings } from "@agentic-kanban/shared/lib/worker-protocol";
import { createRemoteSessionEventRecorder, type BoardEndedReason } from "./agent-remote-events.js";
import { createRemoteLiveness } from "./agent-remote-liveness.js";
import { buildRemoteAssignSpec, dispatchGitTransportAssignment } from "./agent-remote-launch.js";
import { createRemoteRepoService, REPO_OP_TIMEOUT_MS } from "./agent-remote-repo-ops.js";
import { installRemoteSessionHold } from "./agent-remote-hold.js";
import { landSessionBranch, stopUntrackedSessions } from "./agent-remote-finalize.js";
import { getFleetMcpBridge } from "./fleet-mcp-bridge.service.js";
import { deliverRemoteOutput } from "./agent-remote-transcript.js";

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

// The session/service type declarations live in agent-remote.types.ts — this file
// sits at the god-module ceiling, and the types are a cohesive leaf (see
// placement-explain.types.ts for the precedent).
import type { RemoteSession, RemoteSessionRepo, RemoteRepoOpOutcome, RemoteAgentService } from "./agent-remote.types.js";
export type { RemoteSessionRepo, RemoteRepoOpOutcome, RemoteAgentService } from "./agent-remote.types.js";
import { listDetachedSessions, listRemoteOutputTimes } from "./agent-remote-detached.js";

export { REPO_OP_TIMEOUT_MS };
export function createRemoteAgentService(
  manager: WorkerConnectionManager,
  database: Database = realDb,
  // #887 adds probeAfterMs/probeTimeoutMs so an e2e run can exercise the probe round trip.
  opts?: { reconnectGraceMs?: number; abandonMs?: number; assignSettleMs?: number; probeAfterMs?: number; probeTimeoutMs?: number },
): RemoteAgentService {
  const sessions = new Map<string, RemoteSession>();
  const graceMs = opts?.reconnectGraceMs ?? WORKER_RECONNECT_GRACE_MS;
  const abandonMs = Math.max(opts?.abandonMs ?? REMOTE_SESSION_ABANDON_MS, graceMs);
  const assignSettleMs = opts?.assignSettleMs ?? WORKER_ASSIGN_SETTLE_MS;
  // #769: the board-tool bridge for remote builders. Shared per database with the fleet
  // listener that serves it, so the token this path mints is the one that listener resolves.
  const fleetMcp = getFleetMcpBridge(database);
  const repoOps = createRemoteRepoService({ manager, database, sessions });
  // #801 — the assignment's opening and closing rows. A separate module: see its header.
  const { noteAssigned, noteSessionExit, noteUndeliveredResult } = createRemoteSessionEventRecorder(database);

  function finishSession(sessionId: string, session: RemoteSession, stderr: string, exitCode: number | null): void {
    liveness.cancel(sessionId);
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
    reportedExitCode: number | null, endedBy?: BoardEndedReason,
    workerPhases?: WorkerPhaseTimings, landedPushMeansSuccess = false,
  ): Promise<void> {
    liveness.cancel(sessionId);
    sessions.delete(sessionId);
    fleetMcp.revokeSessionTokens(sessionId);
    const landStart = Date.now();
    const exitCode = await landSessionBranch(sessionId, session, reportedExitCode, landedPushMeansSuccess);
    // #1328: the board's own half of the timeline — the incoming-ref fast-forward — beside what the worker sent.
    const phases = session.repo ? { ...workerPhases, landMs: Date.now() - landStart } : undefined;
    noteSessionExit(sessionId, session, exitCode, "landed and finalized", endedBy, phases);
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
        `(daemon restart or crash); its exit can never arrive — landing any pushed result and finalizing it with exit 1 (recorded completed/exitCode 1, not a verified success)`,
    );
    report(
      sessionId,
      session,
      `Fleet worker ${workerId} reconnected without this session: its agent is gone and no exit can ` +
        `arrive (the worker's pending-result queue does not survive a daemon restart). Any result it ` +
        `pushed is being landed on the branch before this session is closed.`,
    );
    // #1420: a pushed result that lands is finalized from the push (exit 0), not as a failure.
    void landAndFinish(sessionId, session, 1, "worker-lost", undefined, true);
  }

  /**
   * #887 — "does this session actually exist on that worker?", both ways of asking, in one
   * module. This file sits at the god-module ceiling, and the two questions (a hello that
   * omits a session; silence after an assign) are one leaf answering one thing.
   */
  const liveness = createRemoteLiveness({
    sessions,
    send: (workerId, message) => manager.send(workerId, message),
    loseSession,
    report,
    // Spread FIRST so the resolved `assignSettleMs` below wins over an absent override; the
    // probe timings ride along, which is what makes the round trip testable end to end (#887).
    ...opts,
    assignSettleMs,
    assignmentLost: (sessionId, session, reason) => {
      // A never-started assignment is a LAUNCH failure, exactly like `assign_failed`: the
      // dispatch proxy owns the host-fallback/strict decision (#245/#751), and routing it
      // there is what makes the ticket retryable instead of a session that exits 1.
      if (session.onDeferredLaunchFailure) {
        sessions.delete(sessionId);
        session.onDeferredLaunchFailure({ kind: "dispatch", reason });
        return;
      }
      finishSession(sessionId, session, `Worker never received this assignment: ${reason}`, 1);
    },
    finalizeExited: (sessionId, session, exitCode) => void landAndFinish(sessionId, session, exitCode),
  });

  manager.onMessage((workerId, message) => {
    if (message.type === "event") {
      const session = sessions.get(message.event.sessionId);
      if (!session || session.workerId !== workerId) return;
      // The worker has spoken about this session, so a later hello that omits it is
      // information rather than a race (see WORKER_ASSIGN_SETTLE_MS).
      liveness.noteObserved(message.event.sessionId);
      if (message.event.type !== "exit") session.lastOutputAtMs = Date.now();
      if (message.event.type !== "exit") {
        deliverRemoteOutput(session.onOutput, message.event);
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
      void landAndFinish(sessionId, session, exitEvent.exitCode ?? null, undefined, exitEvent.phases);
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
      liveness.reconcileHello(workerId, message.runningSessionIds);
      const unknown = message.runningSessionIds.filter((id) => !sessions.has(id));
      if (unknown.length === 0) return;
      void stopUntrackedSessions({ manager, database, workerId, sessionIds: unknown });
      return;
    }
    if (message.type === "session_probe_result") {
      liveness.handleProbeResult(workerId, message.sessionId, message.probe);
      return;
    }
    if (message.type === "git_token_request") {
      void repoOps.handleTokenRequest(workerId, message.sessionId, message.requestId); // #1383
      return;
    }
    if (message.type === "repo_op_result") {
      repoOps.handleResult(workerId, message.result);
      return;
    }
    if (message.type === "undelivered_result") {
      // #871 — extracted to agent-remote-undelivered.ts (this file sits at the god-module ceiling).
      recordUndeliveredResult({
        workerId,
        message,
        database,
        noteUndeliveredResult,
        reportToLiveSession: (text) => {
          const session = sessions.get(message.sessionId);
          if (!session || session.workerId !== workerId) return false;
          report(message.sessionId, session, text);
          return true;
        },
      });
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

  // Disconnect hold / reconnect re-adoption (#746): see agent-remote-hold.ts.
  installRemoteSessionHold({ manager, sessions, graceMs, abandonMs, report, landAndFinish });

  function launch(request: AgentLaunchRequest): AgentHandle {
    // #524: `_containerProvision` stays unread — a remote worker provisions its own environment.
    const { sessionId, onOutput, placement, onDeferredLaunchFailure } = request;
    if (placement?.kind !== "remote") {
      throw new Error("remote agent service requires a remote placement");
    }
    const workerId = placement.workerId;
    const { config, spec } = buildRemoteAssignSpec(request, placement);

    // Same-machine dispatch (no repo in the placement): the worker shares this
    // filesystem, so assign directly; git transport assigns after its async prerequisites.
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
      // #1407: isCancelled — the board stopped the session before its assign was sent
      void dispatchGitTransportAssignment({
        manager, database, sessions, fleetMcp, request, workerId, repo: placement.repo, spec, noteAssigned, finishSession, onDeferredLaunchFailure, isCancelled: () => sessions.get(sessionId)?.killed === true,
      });
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
    liveness.armAssignProbe(sessionId); // #887 — ask, rather than wait out a silence TTL
    updateSessionWorkerId(sessionId, workerId, database)
      .catch((err) => console.error(`[agent-remote] failed to stamp session workerId: sessionId=${sessionId}`, err));
    return {};
  }

  function kill(sessionId: string): boolean {
    const session = sessions.get(sessionId);
    if (!session) return false;
    // #1407: a git-transport assign still being prepared would otherwise reach the worker after this stop.
    session.killed = true;
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
   * On-demand: can this session's stdin still receive a follow-up turn RIGHT NOW (#900)?
   *
   * `adoptSession` defaults a re-adopted session's `stdinOpen` to `false` because the board
   * genuinely cannot know from the DB whether the launch that died with the old process
   * passed `keepStdinOpen` — the honest default, not a bug. The worker actually holds the
   * child's stdin, so it can answer for real. A successful `running` answer UPDATES
   * `session.stdinOpen` from the worker's report, so a subsequent `sendInput` is not
   * refused on the board's own stale default.
   *
   * Silence is never read as open (#887's rule): a timeout or a missing socket answers
   * `{ok:false}`, never a guessed `true`.
   */
  async function probeStdinIdle(
    sessionId: string,
  ): Promise<{ ok: true; stdinOpen: boolean } | { ok: false; reason: string }> {
    const session = sessions.get(sessionId);
    if (!session) {
      return { ok: false, reason: `this board process does not track session ${sessionId} as remote` };
    }
    const probe = await liveness.requestProbe(sessionId);
    if (!probe) {
      return {
        ok: false,
        reason:
          `fleet worker ${session.workerId} did not answer whether session ${sessionId} can still receive ` +
          "input — it may be busy, unreachable, or a build that predates this check (such a worker drops " +
          "the request silently)",
      };
    }
    if (probe.state !== "running") {
      return {
        ok: false,
        reason: `fleet worker ${session.workerId} reports session ${sessionId} is ${probe.state}, not running`,
      };
    }
    session.stdinOpen = probe.stdinOpen === true;
    return { ok: true, stdinOpen: session.stdinOpen };
  }

  function trackedSessionIds(): string[] {
    return [...sessions.keys()];
  }

  // `tracksSession` is `isPidAlive` under a name that says what it actually answers:
  // "this process holds the session", not "a pid is alive somewhere". The dispatch proxy
  // asks it to route a session it never launched — an ADOPTED one (#874) — and aliasing
  // rather than re-deriving is what keeps the two answers from ever disagreeing.
  return {
    launch, kill, sendInput, closeStdin, isStdinOpen, getProcess, getPid, isPidAlive,
    adoptSession, trackedSessionIds, remoteSessionInfo, remoteGitTransportSessions, requestRepoOp: repoOps.requestRepoOp,
    probeStdinIdle, tracksSession: isPidAlive, detachedSessions: () => listDetachedSessions(sessions, graceMs, abandonMs), remoteOutputTimes: () => listRemoteOutputTimes(sessions),
  };
}
