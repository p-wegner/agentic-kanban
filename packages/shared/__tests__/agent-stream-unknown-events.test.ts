import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyAgentStreamLine,
  parseAgentProviderStreamLineObserved,
  getUnknownEventCounters,
  resetUnknownEventCounters,
  setUnknownEventLogger,
  setUnknownEventClock,
  type UnknownEventLogger,
} from "../src/lib/agent-stream-parser.js";

/**
 * Arch-review #898: a VALID JSON agent event of an UNKNOWN type used to be
 * silently swallowed (parser returns undefined, nothing recorded) — the silent
 * failure behind the recurring "0 tokens" misdiagnosis when a CLI renames an
 * event. These tests assert the drift is now observable: classified, counted,
 * and (rate-limited) logged, while recognized events stay unaffected.
 */
describe("agent-stream unknown-event observability", () => {
  let logged: Array<{ message: string; detail: Record<string, unknown> }>;
  let restoreLogger: UnknownEventLogger;
  let restoreClock: () => number;
  let clock: number;

  beforeEach(() => {
    resetUnknownEventCounters();
    logged = [];
    restoreLogger = setUnknownEventLogger((message, detail) => logged.push({ message, detail }));
    clock = 0;
    restoreClock = setUnknownEventClock(() => clock);
  });

  afterEach(() => {
    setUnknownEventLogger(restoreLogger);
    setUnknownEventClock(restoreClock);
    resetUnknownEventCounters();
  });

  describe("classifyAgentStreamLine", () => {
    it("flags valid JSON of a recognized type as recognized", () => {
      const c = classifyAgentStreamLine(
        "codex",
        JSON.stringify({ type: "turn.completed", usage: { total_token_usage: { input_tokens: 5, output_tokens: 2 } } }),
      );
      expect(c.validJson).toBe(true);
      expect(c.recognized).toBe(true);
      expect(c.eventType).toBe("turn.completed");
    });

    it("flags valid JSON of an unknown type as NOT recognized but still validJson", () => {
      const c = classifyAgentStreamLine("codex", JSON.stringify({ type: "turn.finished_v2", usage: {} }));
      expect(c.validJson).toBe(true);
      expect(c.recognized).toBe(false);
      expect(c.eventType).toBe("turn.finished_v2");
      expect(c.event).toBeUndefined();
    });

    it("flags non-JSON lines as not valid JSON", () => {
      const c = classifyAgentStreamLine("codex", "this is not json");
      expect(c.validJson).toBe(false);
      expect(c.recognized).toBe(false);
    });
  });

  describe("parseAgentProviderStreamLineObserved", () => {
    it("records an unknown event type and returns undefined", () => {
      const out = parseAgentProviderStreamLineObserved("codex", JSON.stringify({ type: "turn.renamed" }));
      expect(out).toBeUndefined();
      const { counts, total } = getUnknownEventCounters();
      expect(total).toBe(1);
      expect(counts.get("codex:turn.renamed")).toBe(1);
      expect(logged).toHaveLength(1);
      expect(logged[0].message).toContain("unknown event type");
      expect(logged[0].detail).toMatchObject({ provider: "codex", eventType: "turn.renamed" });
    });

    it("does NOT record recognized events (the regression guard for 0-tokens)", () => {
      const line = JSON.stringify({
        type: "turn.completed",
        usage: { total_token_usage: { input_tokens: 100, output_tokens: 50 } },
      });
      const out = parseAgentProviderStreamLineObserved("codex", line);
      expect(out?.stats?.inputTokens).toBe(100);
      expect(getUnknownEventCounters().total).toBe(0);
      expect(logged).toHaveLength(0);
    });

    it("does NOT record non-JSON noise", () => {
      const out = parseAgentProviderStreamLineObserved("claude", "warming up...");
      expect(out).toBeUndefined();
      expect(getUnknownEventCounters().total).toBe(0);
      expect(logged).toHaveLength(0);
    });

    it("counts a JSON object with no type field under <no-type>", () => {
      parseAgentProviderStreamLineObserved("pi", JSON.stringify({ foo: "bar" }));
      expect(getUnknownEventCounters().counts.get("pi:<no-type>")).toBe(1);
    });

    it("rate-limits the log but keeps counting every occurrence", () => {
      const line = JSON.stringify({ type: "mystery" });
      // 3 within the same window: counted 3x, logged once.
      parseAgentProviderStreamLineObserved("codex", line);
      clock = 100;
      parseAgentProviderStreamLineObserved("codex", line);
      clock = 59_000;
      parseAgentProviderStreamLineObserved("codex", line);
      expect(getUnknownEventCounters().counts.get("codex:mystery")).toBe(3);
      expect(logged).toHaveLength(1);

      // Past the window: logged again.
      clock = 61_000;
      parseAgentProviderStreamLineObserved("codex", line);
      expect(getUnknownEventCounters().counts.get("codex:mystery")).toBe(4);
      expect(logged).toHaveLength(2);
    });

    it("keeps separate counters per provider:type", () => {
      parseAgentProviderStreamLineObserved("codex", JSON.stringify({ type: "a" }));
      parseAgentProviderStreamLineObserved("claude", JSON.stringify({ type: "a" }));
      parseAgentProviderStreamLineObserved("codex", JSON.stringify({ type: "b" }));
      const { counts, total } = getUnknownEventCounters();
      expect(total).toBe(3);
      expect(counts.get("codex:a")).toBe(1);
      expect(counts.get("claude:a")).toBe(1);
      expect(counts.get("codex:b")).toBe(1);
    });
  });

  it("default logger routes through console.warn", () => {
    // Restore default logger for this assertion.
    setUnknownEventLogger(restoreLogger);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseAgentProviderStreamLineObserved("codex", JSON.stringify({ type: "drifted" }));
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
