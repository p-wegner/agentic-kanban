/**
 * "Can this worker still DO anything?" — a capability check, separate from transport (#901).
 *
 * The board admitted a worker for new work on two conditions (`filterEligibleWorkers`): its
 * heartbeat is fresh, and the board holds a WebSocket for it. Both are answered by the
 * daemon's socket and timer layer, and neither asks whether it can still launch an agent.
 * Reported from the far end of a live fleet: an ORPHANED daemon spinning at 102% of a core,
 * mute for hours, still holding an ESTABLISHED connection, was handed a session that produced
 * no `resolved launch intent` line and no process. Their conclusion, which is this module's
 * whole reason to exist: **a live socket is not proof of a working worker.**
 *
 * ## The probe costs no protocol change, because #887 already built it
 *
 * `probe_session` is answered by the worker's session registry, which ALWAYS answers —
 * including `unknown` for an id it has never heard of (`worker-session-registry.ts`). So a
 * probe carrying a SYNTHETIC id is a capability check that works against every already-
 * deployed #887 worker: no new message type, no worker-side change, no upgrade to roll out.
 * It exercises the real path — receive, parse, dispatch, serialize, send — and a daemon
 * wedged anywhere along it cannot fake an answer.
 *
 * ## Why a worker-level consequence is safe where a session-level one is not
 *
 * #887 established, correctly, that **silence is not `unknown`**: a worker older than that
 * protocol drops `probe_session` and never answers, so failing a live SESSION on silence
 * would break every stale worker in a fleet. That rule is preserved here exactly, via the
 * distinction that makes it possible:
 *
 *   - An OLD worker never answers ANY probe.
 *   - A WEDGED worker stops answering after having answered.
 *
 * So a worker that has answered even once has ATTESTED that it speaks the protocol, and from
 * then on repeated silence is positive evidence of a wedged daemon rather than of an old one.
 * A worker that has never answered is exempt forever — see `decideWorkerHealth`, where that
 * is the first condition and the reason it is first.
 *
 * ## It is a HEALTH state, not a trust decision
 *
 * Quarantine withholds NEW work; it never revokes, never kills, and never touches sessions the
 * worker is already holding. It clears itself the moment an answer arrives, which is why the
 * sweep probes every CONNECTED worker rather than every ELIGIBLE one: a quarantine that could
 * only be cleared by work the quarantine prevents would be permanent.
 */
import type { BoardToWorkerMessage, WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";

/** How often each connected worker is asked to prove it can still answer. */
export const HEALTH_PROBE_INTERVAL_MS = 2 * 60 * 1000;

/** How long one probe may go unanswered before it counts as a timeout. */
export const HEALTH_PROBE_TIMEOUT_MS = 30 * 1000;

/**
 * Consecutive unanswered probes before an ATTESTED worker is quarantined. Three rather than
 * one: a single missed 30 s window is survivable load, and a false quarantine on a healthy
 * fleet is a worse failure than the ~6 minutes this costs to detect a real one.
 */
export const UNRESPONSIVE_AFTER_TIMEOUTS = 3;

/**
 * Marks a probe as the board asking about the WORKER rather than about a session. The worker
 * needs no knowledge of this — it answers `unknown` for any id it does not hold, which is the
 * answer we want — but the board must not route the reply into session bookkeeping, and a
 * human reading a worker log should be able to see that nothing was actually lost.
 */
export const HEALTH_PROBE_SESSION_PREFIX = "board-health-probe:";

export function isHealthProbeSessionId(sessionId: string): boolean {
  return sessionId.startsWith(HEALTH_PROBE_SESSION_PREFIX);
}

export interface WorkerHealthState {
  /** Has this worker EVER answered a probe? Sticky: it is a fact about its build, not its mood. */
  attested: boolean;
  consecutiveTimeouts: number;
  lastAnswerAtMs?: number;
}

export interface WorkerHealthVerdict {
  responsive: boolean;
  /** Operator-facing, or null when responsive. */
  reason: string | null;
}

/**
 * The verdict, pure (a **decision function** — see packages/server/CLAUDE.md). Everything
 * time-varying is already reduced into `state`, so the whole rule is one table of cases.
 */
export function decideWorkerHealth(state: WorkerHealthState | undefined): WorkerHealthVerdict {
  // Never probed, or never answered: EXEMPT. This is #887's "silence is not `unknown`" rule,
  // and it is first because it outranks the timeout count rather than being combined with it —
  // a worker older than the probe protocol accumulates timeouts forever and must never be
  // quarantined for it.
  if (!state?.attested) return { responsive: true, reason: null };
  if (state.consecutiveTimeouts < UNRESPONSIVE_AFTER_TIMEOUTS) return { responsive: true, reason: null };
  return {
    responsive: false,
    reason:
      `connected and heartbeating, but has not answered ${state.consecutiveTimeouts} consecutive ` +
      "health probes — the daemon holds a live socket but is not processing messages",
  };
}

export interface WorkerHealthProbeDeps {
  connections: {
    send: (workerId: string, message: BoardToWorkerMessage) => boolean;
    connectedWorkerIds: () => string[];
    onMessage: (listener: (workerId: string, message: WorkerToBoardMessage) => void) => () => void;
    onConnect: (listener: (workerId: string) => void) => () => void;
    onDisconnect: (listener: (workerId: string) => void) => () => void;
  };
  log?: (message: string) => void;
  timeoutMs?: number;
}

export function createWorkerHealthProbe(deps: WorkerHealthProbeDeps) {
  const log = deps.log ?? ((message: string) => console.log(`[worker-health] ${message}`));
  const timeoutMs = deps.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
  const states = new Map<string, WorkerHealthState>();
  /** Probes sent and not yet answered, by worker. One in flight per worker at a time. */
  const inFlight = new Map<string, { requestId: string; timer: NodeJS.Timeout }>();
  let seq = 0;

  function stateOf(workerId: string): WorkerHealthState {
    let state = states.get(workerId);
    if (!state) {
      state = { attested: false, consecutiveTimeouts: 0 };
      states.set(workerId, state);
    }
    return state;
  }

  const unsubscribe = [
    deps.connections.onMessage((workerId, message) => {
      if (message.type !== "session_probe_result") return;
      if (!isHealthProbeSessionId(message.sessionId)) return;
      noteAnswer(workerId, message.probe.requestId);
    }),
    // A NEW socket is new evidence: whatever the old connection was doing, this one was
    // established by code that ran. `attested` is deliberately NOT reset — it records that
    // this worker's build speaks the probe protocol, which a reconnect cannot unlearn.
    deps.connections.onConnect((workerId) => {
      clearInFlight(workerId);
      stateOf(workerId).consecutiveTimeouts = 0;
    }),
    deps.connections.onDisconnect((workerId) => clearInFlight(workerId)),
  ];

  function clearInFlight(workerId: string): void {
    const pending = inFlight.get(workerId);
    if (!pending) return;
    clearTimeout(pending.timer);
    inFlight.delete(workerId);
  }

  function noteAnswer(workerId: string, requestId: string): void {
    const pending = inFlight.get(workerId);
    // An answer to a probe this process never sent (or already timed out on) proves the
    // worker is alive just the same, so it still counts — but it must not clear a NEWER
    // probe's timer, which would credit the new probe with the old one's answer.
    if (pending?.requestId === requestId) clearInFlight(workerId);
    const state = stateOf(workerId);
    const wasUnresponsive = !decideWorkerHealth(state).responsive;
    state.attested = true;
    state.consecutiveTimeouts = 0;
    state.lastAnswerAtMs = Date.now();
    if (wasUnresponsive) {
      log(`worker ${workerId} is answering again — clearing the unresponsive hold, it can take work`);
    }
  }

  function noteTimeout(workerId: string): void {
    inFlight.delete(workerId);
    const state = stateOf(workerId);
    if (!state.attested) return; // Old build, cannot answer. Not a fault, and never counted.
    state.consecutiveTimeouts += 1;
    const verdict = decideWorkerHealth(state);
    if (!verdict.responsive && state.consecutiveTimeouts === UNRESPONSIVE_AFTER_TIMEOUTS) {
      log(
        `worker ${workerId} has missed ${state.consecutiveTimeouts} consecutive health probes while ` +
          "holding a live socket — withholding NEW work from it (running sessions are untouched)",
      );
    }
  }

  /** Ask one worker to prove it can still process a message. */
  function probeWorker(workerId: string): void {
    if (inFlight.has(workerId)) return; // Still waiting on the last one; asking twice proves nothing.
    const requestId = `health-${++seq}-${workerId}`;
    const sessionId = `${HEALTH_PROBE_SESSION_PREFIX}${requestId}`;
    if (!deps.connections.send(workerId, { type: "probe_session", sessionId, requestId })) return;
    const timer = setTimeout(() => noteTimeout(workerId), timeoutMs);
    timer.unref?.();
    inFlight.set(workerId, { requestId, timer });
  }

  /** One pass: probe every connected worker. Registered as a background sweep. */
  function sweep(): void {
    for (const workerId of deps.connections.connectedWorkerIds()) probeWorker(workerId);
  }

  /**
   * Is this worker healthy enough to be handed NEW work? Consulted by `filterEligibleWorkers`.
   * An unknown worker is responsive: absence of evidence is not evidence of a wedged daemon.
   */
  function isResponsive(workerId: string): boolean {
    return decideWorkerHealth(states.get(workerId)).responsive;
  }

  /** Why not, for the operator-facing eligibility explanation. Null when it is fine. */
  function unresponsiveReason(workerId: string): string | null {
    return decideWorkerHealth(states.get(workerId)).reason;
  }

  function dispose(): void {
    for (const workerId of [...inFlight.keys()]) clearInFlight(workerId);
    for (const off of unsubscribe) off();
  }

  return { sweep, probeWorker, isResponsive, unresponsiveReason, stateFor: (id: string) => states.get(id), dispose };
}

export type WorkerHealthProbe = ReturnType<typeof createWorkerHealthProbe>;

/**
 * The **background sweep** half (see packages/server/CLAUDE.md): a module-singleton timer
 * pair, registered in `BACKGROUND_SERVICES`. It takes the probe rather than the fleet on
 * purpose — the fleet BUILDS the probe, so depending on it here would be a cycle.
 */
let sweepTimer: NodeJS.Timeout | undefined;

export function startWorkerHealthProbe(
  probe: WorkerHealthProbe,
  intervalMs: number = HEALTH_PROBE_INTERVAL_MS,
): void {
  stopWorkerHealthProbe();
  sweepTimer = setInterval(() => probe.sweep(), intervalMs);
  sweepTimer.unref?.();
}

export function stopWorkerHealthProbe(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = undefined;
}
