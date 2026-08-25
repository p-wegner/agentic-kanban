/**
 * #887 — the board's half.
 *
 * The property worth pinning hardest is the one the ticket exists for AND its mirror image:
 * an authoritative `unknown` must fail the session in a sub-second round trip, and NO ANSWER
 * must not. A worker built before this protocol drops `probe_session` and never replies, so a
 * probe that treated silence as `unknown` would fail live sessions on every stale worker in a
 * fleet — strictly worse than the 100-minute hang being fixed. Both are asserted below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardToWorkerMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import { createRemoteLiveness } from "../services/agent-remote-liveness.js";
import type { RemoteSession } from "../services/agent-remote.types.js";

const PROBE_AFTER = 60_000;
const PROBE_TIMEOUT = 10_000;
const SETTLE = 30_000;

function harness() {
  const sessions = new Map<string, RemoteSession>();
  const sent: Array<{ workerId: string; message: BoardToWorkerMessage }> = [];
  const calls = { lost: [] as string[], assignmentLost: [] as string[], exited: [] as Array<[string, number | null]> };
  const reports: string[] = [];
  let connected = true;
  const liveness = createRemoteLiveness({
    sessions,
    send: (workerId, message) => {
      if (!connected) return false;
      sent.push({ workerId, message });
      return true;
    },
    loseSession: (sessionId) => void calls.lost.push(sessionId),
    assignmentLost: (sessionId) => void calls.assignmentLost.push(sessionId),
    finalizeExited: (sessionId, _session, exitCode) => void calls.exited.push([sessionId, exitCode]),
    report: (_sessionId, _session, text) => void reports.push(text),
    assignSettleMs: SETTLE,
    probeAfterMs: PROBE_AFTER,
    probeTimeoutMs: PROBE_TIMEOUT,
    log: () => {},
  });
  const track = (sessionId: string, workerId = "w1"): RemoteSession => {
    const session: RemoteSession = { workerId, onOutput: () => {}, stdinOpen: false };
    sessions.set(sessionId, session);
    return session;
  };
  return {
    liveness, sessions, sent, calls, reports, track,
    disconnect: () => { connected = false; },
    requestIdFor: (sessionId: string) => sessions.get(sessionId)?.probeRequestId ?? "",
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the silence-after-assign probe (#887)", () => {
  it("asks the worker once the session has been silent past the threshold", () => {
    const h = harness();
    h.track("s1");
    h.liveness.armAssignProbe("s1");
    expect(h.sent).toEqual([]);
    vi.advanceTimersByTime(PROBE_AFTER);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message).toMatchObject({ type: "probe_session", sessionId: "s1" });
  });

  it("never asks about a session the worker has already spoken about", () => {
    const h = harness();
    h.track("s1");
    h.liveness.armAssignProbe("s1");
    h.liveness.noteObserved("s1"); // one byte of stdout is proof the assign landed
    vi.advanceTimersByTime(PROBE_AFTER * 5);
    expect(h.sent).toEqual([]);
  });

  it("fails the session immediately on an authoritative UNKNOWN, as a re-placeable LAUNCH failure", () => {
    const h = harness();
    h.track("s1");
    h.liveness.armAssignProbe("s1");
    vi.advanceTimersByTime(PROBE_AFTER);
    h.liveness.handleProbeResult("w1", "s1", { requestId: h.requestIdFor("s1"), state: "unknown" });
    expect(h.calls.assignmentLost).toEqual(["s1"]);
    expect(h.reports.join(" ")).toMatch(/never arrived/);
  });

  it("HOLDS when the worker never answers — silence is not `unknown`", () => {
    // The regression that would matter most: a worker older than this protocol drops the
    // request as an unknown type. Failing it here would break every stale worker in a fleet.
    const h = harness();
    h.track("s1");
    h.liveness.armAssignProbe("s1");
    vi.advanceTimersByTime(PROBE_AFTER + PROBE_TIMEOUT * 10);
    expect(h.calls.assignmentLost).toEqual([]);
    expect(h.calls.lost).toEqual([]);
    expect(h.sessions.has("s1")).toBe(true);
  });

  it("treats RUNNING as proof the assignment landed, and stops re-deriving it", () => {
    const h = harness();
    h.track("s1");
    h.liveness.armAssignProbe("s1");
    vi.advanceTimersByTime(PROBE_AFTER);
    h.liveness.handleProbeResult("w1", "s1", { requestId: h.requestIdFor("s1"), state: "running", pid: 99 });
    expect(h.calls.assignmentLost).toEqual([]);
    expect(h.sessions.get("s1")?.observed).toBe(true);
    expect(h.reports.join(" ")).toMatch(/still running \(pid 99\)/);
  });

  it("finalizes on EXITED — the run finished and only its exit event was lost", () => {
    const h = harness();
    h.track("s1");
    h.liveness.armAssignProbe("s1");
    vi.advanceTimersByTime(PROBE_AFTER);
    h.liveness.handleProbeResult("w1", "s1", { requestId: h.requestIdFor("s1"), state: "exited", exitCode: 2 });
    expect(h.calls.exited).toEqual([["s1", 2]]);
  });

  it("ignores an `unknown` from a worker the session was NOT assigned to", () => {
    // A different machine not knowing an id means nothing at all.
    const h = harness();
    h.track("s1", "w1");
    h.liveness.armAssignProbe("s1");
    vi.advanceTimersByTime(PROBE_AFTER);
    h.liveness.handleProbeResult("w2", "s1", { requestId: h.requestIdFor("s1"), state: "unknown" });
    expect(h.calls.assignmentLost).toEqual([]);
  });

  it("ignores an answer whose requestId does not match the probe in flight", () => {
    const h = harness();
    h.track("s1");
    h.liveness.armAssignProbe("s1");
    vi.advanceTimersByTime(PROBE_AFTER);
    h.liveness.handleProbeResult("w1", "s1", { requestId: "some-older-probe", state: "unknown" });
    expect(h.calls.assignmentLost).toEqual([]);
  });

  it("does not ask a worker whose socket is gone — the disconnect bounds own that case", () => {
    const h = harness();
    h.track("s1");
    h.liveness.armAssignProbe("s1");
    h.disconnect();
    vi.advanceTimersByTime(PROBE_AFTER + PROBE_TIMEOUT * 2);
    expect(h.calls.assignmentLost).toEqual([]);
    expect(h.sessions.get("s1")?.probeRequestId).toBeUndefined();
  });

  it("cancels its timers when the session is finalized elsewhere", () => {
    const h = harness();
    h.track("s1");
    h.liveness.armAssignProbe("s1");
    h.liveness.cancel("s1");
    vi.advanceTimersByTime(PROBE_AFTER * 5);
    expect(h.sent).toEqual([]);
  });
});

describe("the hello reverse-reconcile (#746, moved here in #887)", () => {
  it("loses a session the worker has spoken about and no longer lists", () => {
    const h = harness();
    h.track("s1").observed = true;
    h.liveness.reconcileHello("w1", []);
    expect(h.calls.lost).toEqual(["s1"]);
  });

  it("leaves a session the hello DOES list alone", () => {
    const h = harness();
    h.track("s1").observed = true;
    h.liveness.reconcileHello("w1", ["s1"]);
    expect(h.calls.lost).toEqual([]);
  });

  it("re-checks a never-observed session after the settle window rather than guessing", () => {
    const h = harness();
    h.track("s1");
    h.liveness.reconcileHello("w1", []);
    expect(h.calls.lost).toEqual([]);
    vi.advanceTimersByTime(SETTLE);
    expect(h.calls.lost).toEqual(["s1"]);
  });

  it("does not lose a session that spoke up inside the settle window", () => {
    // The race this exists for: a reconnect crossing a fresh assign.
    const h = harness();
    h.track("s1");
    h.liveness.reconcileHello("w1", []);
    h.liveness.noteObserved("s1");
    vi.advanceTimersByTime(SETTLE * 3);
    expect(h.calls.lost).toEqual([]);
  });

  it("ignores sessions belonging to another worker", () => {
    const h = harness();
    h.track("s1", "w2").observed = true;
    h.liveness.reconcileHello("w1", []);
    expect(h.calls.lost).toEqual([]);
  });
});
