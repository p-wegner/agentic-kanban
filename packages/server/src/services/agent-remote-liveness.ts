/**
 * "Does this session actually exist on that worker?" — the board's two ways of asking (#887).
 *
 * The board could not tell **"the assignment never arrived"** from **"the agent is working
 * silently"**. Zero output is not evidence: a real agent can legitimately produce nothing for
 * a long stretch, which is exactly why the board waits. Measured, it waited 100 minutes on
 * session `b4f7548f` — whose id appears nowhere in the worker's 114 KB log, not even on the
 * "resolved launch intent" line the worker writes BEFORE spawning. The assignment was lost in
 * transit and the board spent an hour and a half treating a non-event as possible progress.
 *
 * There are exactly two moments where that ambiguity bites, and this module owns both:
 *
 *  - **A `hello`.** The reconcile is free — the worker enumerates what it holds, so a session
 *    the board tracks on that worker and the hello does not list is `unknown` by definition.
 *    This half needed no new message and predates the ticket (#746); it lives here now because
 *    it answers the same question by the same rule.
 *  - **Silence after an `assign`.** Nothing enumerates anything, so the board must ASK. The
 *    worker remembers every id it was ever handed (`worker-session-registry.ts`), so its
 *    `unknown` is an AUTHORITATIVE never-started answer — a fact, in a way "no output" can
 *    never be. That turns a two-hour timeout into a sub-second round trip.
 *
 * **Silence is not `unknown`.** A worker built before this protocol drops `probe_session` as
 * an unknown type and never answers, so an unanswered probe must fall back to today's
 * behaviour — hold, and let #883's `RUNNING_SESSION_SILENCE_TTL_MS` be the backstop. Treating
 * no-answer as `unknown` would fail live sessions on every stale worker in a fleet, which is
 * strictly worse than the bug being fixed.
 *
 * **`unknown` counts only from the worker the session was assigned TO.** A different worker
 * not knowing an id means nothing at all.
 */
import type { BoardToWorkerMessage, WorkerSessionProbe } from "@agentic-kanban/shared/lib/worker-protocol";
import type { RemoteSession } from "./agent-remote.types.js";

/**
 * How long an assigned session may produce nothing before the board ASKS (#887).
 *
 * Minutes, not hours: the whole point is that the answer is authoritative, so waiting out a
 * timeout first would throw away what the probe buys. Long enough that an ordinary cold start
 * — a git-transport clone plus a setup script on a cold worker — is not interrupted by a
 * question, and a probe answered `running` costs nothing anyway.
 */
export const ASSIGN_SILENCE_PROBE_MS = 5 * 60 * 1000;

/** How long the board waits for an answer before falling back to holding. */
export const SESSION_PROBE_TIMEOUT_MS = 30 * 1000;

export interface RemoteLivenessDeps {
  /** The service's live session map. Read here; mutated only through the callbacks below. */
  sessions: Map<string, RemoteSession>;
  send: (workerId: string, message: BoardToWorkerMessage) => boolean;
  /**
   * The worker is up and does not have this session: land anything it pushed, then finalize
   * non-zero. Used for a hello that omits a session the board has SEEN the worker speak about.
   */
  loseSession: (sessionId: string, workerId: string) => void;
  /**
   * The assignment never arrived. A LAUNCH failure, not a run that exited 1 — so it goes to
   * the dispatch proxy's placement rule (#751) and the ticket is retryable, rather than being
   * flattened into an exit code here.
   */
  assignmentLost: (sessionId: string, session: RemoteSession, reason: string) => void;
  /** The worker says it exited and the exit event was lost — finalize on the reported code. */
  finalizeExited: (sessionId: string, session: RemoteSession, exitCode: number | null) => void;
  /** Write into the session's own transcript, so a hold is visible where the run is. */
  report: (sessionId: string, session: RemoteSession, text: string) => void;
  assignSettleMs: number;
  probeAfterMs?: number;
  probeTimeoutMs?: number;
  log?: (message: string) => void;
}

function unrefed(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  if (timer.unref) timer.unref();
  return timer;
}

export function createRemoteLiveness(deps: RemoteLivenessDeps) {
  const { sessions, assignSettleMs } = deps;
  const probeAfterMs = deps.probeAfterMs ?? ASSIGN_SILENCE_PROBE_MS;
  const probeTimeoutMs = deps.probeTimeoutMs ?? SESSION_PROBE_TIMEOUT_MS;
  const log = deps.log ?? ((message: string) => console.warn(`[agent-remote] ${message}`));
  let probeSeq = 0;
  /**
   * On-demand probes awaiting an answer, by `requestId` (#900). Separate from the
   * silence-triggered flow above: a follow-up turn needs the answer NOW, not after
   * `ASSIGN_SILENCE_PROBE_MS` of nothing, and it needs the answer delivered TO IT rather
   * than only acted on as a side effect.
   */
  const pendingOnDemand = new Map<string, (probe: WorkerSessionProbe | null) => void>();

  /** Drop every timer this module armed for a session. Idempotent. */
  function cancel(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (session.lostCheckTimer) clearTimeout(session.lostCheckTimer);
    if (session.probeTimer) clearTimeout(session.probeTimer);
    session.lostCheckTimer = undefined;
    session.probeTimer = undefined;
    session.probeRequestId = undefined;
  }

  /**
   * The worker has spoken about this session, so it demonstrably took the assign: no probe is
   * needed, and a later hello that omits it is information rather than a race.
   */
  function noteObserved(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.observed = true;
    cancel(sessionId);
  }

  /** Ask, once, if this session has been silent since it was assigned. */
  function armAssignProbe(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session || session.probeTimer) return;
    session.probeTimer = unrefed(setTimeout(() => askWorker(sessionId), probeAfterMs));
  }

  function askWorker(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.probeTimer = undefined;
    // Observed = the worker has already proved it took this assignment. Nothing to ask.
    if (session.observed) return;
    const requestId = `probe-${++probeSeq}-${sessionId}`;
    session.probeRequestId = requestId;
    if (!deps.send(session.workerId, { type: "probe_session", sessionId, requestId })) {
      // No socket. The disconnect grace / abandon bounds own that case; asking is not part of it.
      session.probeRequestId = undefined;
      return;
    }
    log(
      `session ${sessionId} has produced nothing since it was assigned to worker ${session.workerId} ` +
        `${Math.round(probeAfterMs / 60000)}m ago — asking the worker whether it ever received it`,
    );
    session.probeTimer = unrefed(setTimeout(() => {
      const current = sessions.get(sessionId);
      if (!current || current.probeRequestId !== requestId) return;
      current.probeTimer = undefined;
      current.probeRequestId = undefined;
      // Deliberately NOT treated as `unknown`: a worker build older than this protocol drops
      // the request and cannot answer. Holding is what that worker got before, and #883's
      // silence TTL still bounds it.
      log(
        `worker ${current.workerId} did not answer the probe for session ${sessionId} within ` +
          `${Math.round(probeTimeoutMs / 1000)}s — holding (a worker older than this protocol cannot answer)`,
      );
    }, probeTimeoutMs));
  }

  /**
   * Ask the worker about a session RIGHT NOW rather than waiting for the silence timer
   * (#900): a follow-up turn needs the answer before it can be delivered. Supersedes any
   * in-flight silence probe for this session — only the freshest answer matters, and the
   * old timer's own stale-id check makes it a silent no-op once this overwrites the id.
   *
   * Resolves `null` on no socket or no answer within the bound. Deliberately NOT `unknown`:
   * silence is not `unknown` here either, for the same reason as the passive probe above.
   */
  function requestProbe(sessionId: string, opts?: { timeoutMs?: number }): Promise<WorkerSessionProbe | null> {
    const session = sessions.get(sessionId);
    if (!session) return Promise.resolve(null);
    cancel(sessionId);
    const requestId = `probe-ondemand-${++probeSeq}-${sessionId}`;
    session.probeRequestId = requestId;
    if (!deps.send(session.workerId, { type: "probe_session", sessionId, requestId })) {
      session.probeRequestId = undefined;
      return Promise.resolve(null);
    }
    const timeoutMs = opts?.timeoutMs ?? probeTimeoutMs;
    return new Promise((resolve) => {
      let settled = false;
      const timer = unrefed(setTimeout(() => {
        if (settled) return;
        settled = true;
        pendingOnDemand.delete(requestId);
        resolve(null);
      }, timeoutMs));
      pendingOnDemand.set(requestId, (probe) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(probe);
      });
    });
  }

  /** One `session_probe_result`. Trusted only from the worker the session was assigned to. */
  function handleProbeResult(workerId: string, sessionId: string, probe: WorkerSessionProbe): void {
    const session = sessions.get(sessionId);
    if (!session || session.workerId !== workerId) return;
    if (session.probeRequestId !== probe.requestId) return; // stale or unsolicited
    const onDemand = pendingOnDemand.get(probe.requestId);
    if (onDemand) {
      pendingOnDemand.delete(probe.requestId);
      onDemand(probe);
    }
    cancel(sessionId);
    if (probe.state === "unknown") {
      const reason =
        `worker ${workerId} has no record of session ${sessionId}: the assignment never arrived ` +
        "(the worker remembers every session id it was handed, so this is a fact rather than a timeout)";
      log(`ASSIGNMENT LOST — ${reason}`);
      deps.report(sessionId, session, `Fleet dispatch failed: ${reason}. Re-placing this launch.`);
      deps.assignmentLost(sessionId, session, reason);
      return;
    }
    if (probe.state === "exited") {
      log(
        `worker ${workerId} reports session ${sessionId} already exited (code ${probe.exitCode ?? "null"}); ` +
          "its exit event was lost — finalizing on the worker's answer",
      );
      deps.report(
        sessionId,
        session,
        `Fleet worker ${workerId} reports this session already exited (code ${probe.exitCode ?? "null"}) ` +
          "but its exit event never reached the board. Landing any pushed result and closing it.",
      );
      deps.finalizeExited(sessionId, session, probe.exitCode ?? null);
      return;
    }
    // Running: the assignment DID land, and this is the genuinely-silent-but-alive case #883's
    // TTL exists for. Mark it observed so nothing else has to re-derive that.
    session.observed = true;
    log(`worker ${workerId} confirms session ${sessionId} is running (pid ${probe.pid ?? "unknown"}) but silent`);
    deps.report(
      sessionId,
      session,
      `Fleet worker ${workerId} confirms this session is still running` +
        (probe.pid ? ` (pid ${probe.pid})` : "") +
        " — it has simply produced no output yet.",
    );
  }

  /**
   * The reverse half of a `hello` (#746): sessions the board tracks on this worker that the
   * worker's own enumeration does not list. A hello is POSITIVE information — the daemon is up
   * and has said what it holds — and the exit can no longer reach us in any branch, so holding
   * would hang the workspace forever.
   */
  function reconcileHello(workerId: string, runningSessionIds: string[]): void {
    const listed = new Set(runningSessionIds);
    for (const [sessionId, session] of sessions) {
      if (session.workerId !== workerId || listed.has(sessionId)) continue;
      if (session.observed) {
        deps.loseSession(sessionId, workerId);
        continue;
      }
      // Never observed: this hello may simply have crossed a fresh assign. Re-check once the
      // settle window has passed instead of guessing either way — skipping outright would
      // reinstate the infinite hang for an ADOPTED session (which this process has never seen
      // an event for), and acting now fails live work.
      if (session.lostCheckTimer) continue;
      log(
        `worker ${workerId} does not list session ${sessionId}, which this process has not yet seen it ` +
          `speak about; re-checking in ${Math.round(assignSettleMs / 1000)}s`,
      );
      session.lostCheckTimer = unrefed(setTimeout(() => {
        const current = sessions.get(sessionId);
        if (!current || current.workerId !== workerId) return;
        current.lostCheckTimer = undefined;
        if (current.observed) return;
        deps.loseSession(sessionId, workerId);
      }, assignSettleMs));
    }
  }

  return { armAssignProbe, noteObserved, handleProbeResult, reconcileHello, cancel, requestProbe };
}

export type RemoteLiveness = ReturnType<typeof createRemoteLiveness>;
