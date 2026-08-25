/**
 * #901 — a wedged daemon keeps a healthy socket, so transport liveness cannot be the
 * work-capability signal.
 *
 * The two halves that must both hold:
 *  1. An ATTESTED worker that stops answering becomes ineligible for NEW work, with a reason
 *     that names unresponsiveness rather than "offline".
 *  2. A worker that has NEVER answered is exempt forever. That is #887's "silence is not
 *     `unknown`" rule, and this ticket must not weaken it — a worker built before the probe
 *     protocol drops the message and cannot answer, so counting its silence would quarantine
 *     every stale worker in a fleet.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createWorkerHealthProbe,
  decideWorkerHealth,
  isHealthProbeSessionId,
  HEALTH_PROBE_SESSION_PREFIX,
  UNRESPONSIVE_AFTER_TIMEOUTS,
  type WorkerHealthProbeDeps,
} from "../services/worker-health-probe.service.js";
import type { BoardToWorkerMessage, WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";

const TIMEOUT_MS = 1000;
const WORKER = "w-901";

function harness(options: { connected?: string[]; sendOk?: boolean } = {}) {
  const sent: Array<{ workerId: string; message: BoardToWorkerMessage }> = [];
  const logs: string[] = [];
  let onMessage: ((workerId: string, message: WorkerToBoardMessage) => void) | undefined;
  let onConnect: ((workerId: string) => void) | undefined;

  const connections: WorkerHealthProbeDeps["connections"] = {
    send: (workerId, message) => {
      sent.push({ workerId, message });
      return options.sendOk ?? true;
    },
    connectedWorkerIds: () => options.connected ?? [WORKER],
    onMessage: (l) => {
      onMessage = l;
      return () => {};
    },
    onConnect: (l) => {
      onConnect = l;
      return () => {};
    },
    onDisconnect: () => () => {},
  };

  const probe = createWorkerHealthProbe({ connections, timeoutMs: TIMEOUT_MS, log: (m) => logs.push(m) });

  /** Reply to the last probe sent to a worker, the way a healthy daemon would. */
  function answerLast(workerId = WORKER, requestIdOverride?: string) {
    const last = [...sent].reverse().find((s) => s.workerId === workerId);
    const message = last?.message as Extract<BoardToWorkerMessage, { type: "probe_session" }>;
    onMessage?.(workerId, {
      type: "session_probe_result",
      sessionId: message.sessionId,
      probe: { requestId: requestIdOverride ?? message.requestId, state: "unknown" },
    });
  }

  /** Let a probe go unanswered past its timeout. */
  function timeOutLast() {
    vi.advanceTimersByTime(TIMEOUT_MS + 1);
  }

  return { probe, sent, logs, answerLast, timeOutLast, connect: (id = WORKER) => onConnect?.(id) };
}

describe("the verdict itself (#901)", () => {
  it("exempts a worker that has never answered, whatever its timeout count", () => {
    // The #887 rule. A pre-protocol worker accumulates timeouts forever and is never at fault.
    expect(decideWorkerHealth({ attested: false, consecutiveTimeouts: 999 })).toEqual({
      responsive: true,
      reason: null,
    });
  });

  it("exempts an unknown worker — absence of evidence is not evidence of a wedged daemon", () => {
    expect(decideWorkerHealth(undefined).responsive).toBe(true);
  });

  it("holds an attested worker only once the threshold is REACHED, not before", () => {
    const below = { attested: true, consecutiveTimeouts: UNRESPONSIVE_AFTER_TIMEOUTS - 1 };
    const at = { attested: true, consecutiveTimeouts: UNRESPONSIVE_AFTER_TIMEOUTS };
    expect(decideWorkerHealth(below).responsive).toBe(true);
    expect(decideWorkerHealth(at).responsive).toBe(false);
    expect(decideWorkerHealth(at).reason).toMatch(/not processing messages/);
  });

  it("gives a reason that does NOT read as offline — the distinction is the whole point", () => {
    const reason = decideWorkerHealth({ attested: true, consecutiveTimeouts: UNRESPONSIVE_AFTER_TIMEOUTS }).reason!;
    expect(reason).toMatch(/connected and heartbeating/);
    expect(reason).not.toMatch(/offline/);
  });
});

describe("probing a worker over the #887 channel (#901)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("asks with a SYNTHETIC session id, so no worker change is needed", () => {
    // The worker's session registry always answers, including `unknown` for an id it has
    // never held — which is exactly the answer that proves it processed the message.
    const h = harness();
    h.probe.sweep();
    const message = h.sent[0]!.message as Extract<BoardToWorkerMessage, { type: "probe_session" }>;
    expect(message.type).toBe("probe_session");
    expect(message.sessionId.startsWith(HEALTH_PROBE_SESSION_PREFIX)).toBe(true);
    expect(isHealthProbeSessionId(message.sessionId)).toBe(true);
  });

  it("does not ask twice while one probe is still in flight", () => {
    const h = harness();
    h.probe.sweep();
    h.probe.sweep();
    expect(h.sent).toHaveLength(1);
  });

  it("quarantines an ATTESTED worker after the threshold, and not one probe sooner", () => {
    const h = harness();
    h.probe.sweep();
    h.answerLast(); // attests: this build speaks the protocol
    expect(h.probe.isResponsive(WORKER)).toBe(true);

    for (let i = 0; i < UNRESPONSIVE_AFTER_TIMEOUTS - 1; i++) {
      h.probe.sweep();
      h.timeOutLast();
      expect(h.probe.isResponsive(WORKER)).toBe(true);
    }
    h.probe.sweep();
    h.timeOutLast();
    expect(h.probe.isResponsive(WORKER)).toBe(false);
    expect(h.probe.unresponsiveReason(WORKER)).toMatch(/consecutive/);
    expect(h.logs.join("\n")).toMatch(/withholding NEW work/);
  });

  it("NEVER quarantines a worker that has not answered a single probe", () => {
    // The regression this ticket must not break. Same silence, ten times the threshold.
    const h = harness();
    for (let i = 0; i < UNRESPONSIVE_AFTER_TIMEOUTS * 10; i++) {
      h.probe.sweep();
      h.timeOutLast();
    }
    expect(h.probe.isResponsive(WORKER)).toBe(true);
    expect(h.probe.unresponsiveReason(WORKER)).toBeNull();
    expect(h.probe.stateFor(WORKER)?.consecutiveTimeouts).toBe(0);
  });

  it("clears the hold the moment the worker answers again — it is health, not trust", () => {
    // And the sweep keeps probing CONNECTED workers, not eligible ones, which is what makes
    // this reachable at all: a quarantine only clearable by work the quarantine prevents
    // would be permanent.
    const h = harness();
    h.probe.sweep();
    h.answerLast();
    for (let i = 0; i < UNRESPONSIVE_AFTER_TIMEOUTS; i++) {
      h.probe.sweep();
      h.timeOutLast();
    }
    expect(h.probe.isResponsive(WORKER)).toBe(false);

    h.probe.sweep();
    h.answerLast();
    expect(h.probe.isResponsive(WORKER)).toBe(true);
    expect(h.logs.join("\n")).toMatch(/answering again/);
  });

  it("counts a late answer as proof of life without crediting the newer probe's timer", () => {
    const h = harness();
    h.probe.sweep();
    const stale = (h.sent[0]!.message as Extract<BoardToWorkerMessage, { type: "probe_session" }>).requestId;
    h.timeOutLast();
    h.probe.sweep(); // a NEW probe is now in flight
    h.answerLast(WORKER, stale); // ...and the OLD one is answered
    // The worker is alive, so it is attested and its streak resets; but the new probe is
    // still outstanding, so a following timeout must still be able to count.
    expect(h.probe.stateFor(WORKER)?.attested).toBe(true);
    expect(h.probe.stateFor(WORKER)?.consecutiveTimeouts).toBe(0);
    h.timeOutLast();
    expect(h.probe.stateFor(WORKER)?.consecutiveTimeouts).toBe(1);
  });

  it("resets the streak on a reconnect but remembers that the build can answer", () => {
    const h = harness();
    h.probe.sweep();
    h.answerLast();
    for (let i = 0; i < UNRESPONSIVE_AFTER_TIMEOUTS; i++) {
      h.probe.sweep();
      h.timeOutLast();
    }
    expect(h.probe.isResponsive(WORKER)).toBe(false);
    h.connect();
    expect(h.probe.isResponsive(WORKER)).toBe(true);
    // Attestation survives: a reconnect cannot make a build stop speaking the protocol.
    expect(h.probe.stateFor(WORKER)?.attested).toBe(true);
  });

  it("does not arm a timeout when the send itself failed — there is no socket to judge", () => {
    const h = harness({ sendOk: false });
    h.probe.sweep();
    h.answerLast();
    h.probe.sweep();
    h.timeOutLast();
    expect(h.probe.stateFor(WORKER)?.consecutiveTimeouts).toBe(0);
  });
});
