/**
 * #887 — the wire half of the session probe.
 *
 * These parsers are the only thing standing between a malformed frame and a board that acts
 * on it, and this particular message ENDS SESSIONS: an `unknown` fails a launch. So the cases
 * below are mostly about what must be REFUSED — an answer with no state, an unrecognised
 * state, a missing correlation id — because a parser that shape-checks loosely here turns a
 * garbled frame into a killed run.
 */
import { describe, expect, it } from "vitest";
import {
  parseBoardToWorkerMessage,
  parseWorkerSessionProbe,
  parseWorkerToBoardMessage,
} from "../src/lib/worker-protocol.js";

describe("probe_session (board -> worker)", () => {
  it("parses a well-formed request", () => {
    expect(parseBoardToWorkerMessage({ type: "probe_session", sessionId: "s1", requestId: "r1" })).toEqual({
      type: "probe_session",
      sessionId: "s1",
      requestId: "r1",
    });
  });

  it("refuses a request with no correlation id — an uncorrelated answer cannot be trusted", () => {
    expect(parseBoardToWorkerMessage({ type: "probe_session", sessionId: "s1" })).toBeNull();
    expect(parseBoardToWorkerMessage({ type: "probe_session", sessionId: "s1", requestId: "" })).toBeNull();
  });

  it("survives the JSON round trip the socket actually performs", () => {
    const raw = JSON.stringify({ type: "probe_session", sessionId: "s1", requestId: "r1" });
    expect(parseBoardToWorkerMessage(raw)).toMatchObject({ type: "probe_session", requestId: "r1" });
  });
});

describe("session_probe_result (worker -> board)", () => {
  it("parses each of the three states", () => {
    for (const state of ["unknown", "running", "exited"] as const) {
      const parsed = parseWorkerToBoardMessage({
        type: "session_probe_result",
        sessionId: "s1",
        probe: { requestId: "r1", state },
      });
      expect(parsed).toEqual({ type: "session_probe_result", sessionId: "s1", probe: { requestId: "r1", state } });
    }
  });

  it("keeps a null exitCode, which is a real outcome (killed by a signal)", () => {
    const probe = parseWorkerSessionProbe({ requestId: "r1", state: "exited", exitCode: null });
    expect(probe).toEqual({ requestId: "r1", state: "exited", exitCode: null });
  });

  it("carries the running details the operator's report names", () => {
    const probe = parseWorkerSessionProbe({
      requestId: "r1",
      state: "running",
      pid: 4242,
      startedAtMs: 1000,
      lastOutputAtMs: 2000,
    });
    expect(probe).toMatchObject({ pid: 4242, startedAtMs: 1000, lastOutputAtMs: 2000 });
  });

  it("DROPS a state it does not recognise rather than guessing one", () => {
    expect(parseWorkerSessionProbe({ requestId: "r1", state: "maybe" })).toBeNull();
    expect(parseWorkerSessionProbe({ requestId: "r1" })).toBeNull();
    expect(parseWorkerSessionProbe({ state: "unknown" })).toBeNull();
    expect(
      parseWorkerToBoardMessage({ type: "session_probe_result", sessionId: "s1", probe: { state: "unknown" } }),
    ).toBeNull();
  });

  it("drops non-numeric timings instead of letting them through as strings", () => {
    const probe = parseWorkerSessionProbe({ requestId: "r1", state: "running", pid: "4242", startedAtMs: NaN });
    expect(probe).toEqual({ requestId: "r1", state: "running" });
  });
});
