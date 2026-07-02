import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyAgentStreamLine,
  createAgentStreamParseContext,
  parseAgentProviderStreamLineObserved,
  parseAgentStreamLineObserved,
  getUnknownEventCounters,
  resetUnknownEventCounters,
  setUnknownEventLogger,
  setUnknownEventClock,
  UNKNOWN_EVENT_ALERT_THRESHOLD,
  UNKNOWN_EVENT_ALERT_WINDOW_MS,
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

  describe("known-but-fieldless claude events are recognized, not drift (#969)", () => {
    it("classifies a plain text-only user message as recognized", () => {
      const line = JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "please continue" }] },
      });
      const c = classifyAgentStreamLine("claude", line);
      expect(c.validJson).toBe(true);
      expect(c.recognized).toBe(true);
      parseAgentProviderStreamLineObserved("claude", line);
      expect(getUnknownEventCounters().total).toBe(0);
      expect(logged).toHaveLength(0);
    });

    it("classifies a system event with an unhandled subtype as recognized", () => {
      const c = classifyAgentStreamLine("claude", JSON.stringify({ type: "system", subtype: "compact_boundary" }));
      expect(c.recognized).toBe(true);
      expect(getUnknownEventCounters().total).toBe(0);
    });

    it("healthy fieldless traffic never trips the drift ALERT", () => {
      const line = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
      for (let i = 0; i < UNKNOWN_EVENT_ALERT_THRESHOLD * 2; i++) {
        parseAgentProviderStreamLineObserved("claude", line);
      }
      expect(logged).toHaveLength(0);
    });

    it("still counts a truly unknown claude event type", () => {
      parseAgentProviderStreamLineObserved("claude", JSON.stringify({ type: "user_v2" }));
      expect(getUnknownEventCounters().counts.get("claude:user_v2")).toBe(1);
    });
  });

  describe("alert re-arms across rolling windows (#969)", () => {
    it("re-alerts in a later window instead of latching once per process lifetime", () => {
      const line = JSON.stringify({ type: "drift" });
      for (let i = 0; i < UNKNOWN_EVENT_ALERT_THRESHOLD; i++) {
        parseAgentProviderStreamLineObserved("codex", line);
      }
      expect(logged.filter((l) => l.message.includes("ALERT:"))).toHaveLength(1);

      // A second burst in a LATER window alerts again — no permanent latch.
      clock += UNKNOWN_EVENT_ALERT_WINDOW_MS + 1;
      for (let i = 0; i < UNKNOWN_EVENT_ALERT_THRESHOLD; i++) {
        parseAgentProviderStreamLineObserved("codex", line);
      }
      expect(logged.filter((l) => l.message.includes("ALERT:"))).toHaveLength(2);
    });

    it("does not alert when occurrences are spread thinly across windows", () => {
      const line = JSON.stringify({ type: "sporadic" });
      for (let i = 0; i < UNKNOWN_EVENT_ALERT_THRESHOLD * 2; i++) {
        parseAgentProviderStreamLineObserved("codex", line);
        clock += UNKNOWN_EVENT_ALERT_WINDOW_MS; // each occurrence lands in a fresh window
      }
      expect(logged.filter((l) => l.message.includes("ALERT:"))).toHaveLength(0);
    });
  });

  describe("copilot catch-all fallback counts as unknown (#968)", () => {
    it("classifies an unmatched copilot type as NOT recognized while keeping the raw display fallback", () => {
      const c = classifyAgentStreamLine("copilot", JSON.stringify({ type: "totally.new_event", message: "hi" }));
      expect(c.validJson).toBe(true);
      expect(c.recognized).toBe(false);
      expect(c.eventType).toBe("totally.new_event");
      // UI continuity: the raw display fallback is still produced.
      expect(c.event?.displayEvents).toEqual([{ kind: "raw", text: "hi" }]);
    });

    it("records an unknown event for an unmatched copilot type (drift is no longer invisible)", () => {
      const out = parseAgentStreamLineObserved("copilot", JSON.stringify({ type: "totally.new_event" }));
      // The raw fallback is still returned for display...
      expect(out?.displayEvents?.[0]).toMatchObject({ kind: "raw" });
      // ...but the drift detector counted it.
      expect(getUnknownEventCounters().counts.get("copilot:totally.new_event")).toBe(1);
      expect(logged).toHaveLength(1);
    });

    it("still recognizes known copilot event types without counting them", () => {
      const c = classifyAgentStreamLine("copilot", JSON.stringify({ type: "assistant.message", data: { content: "done" } }));
      expect(c.recognized).toBe(true);
      parseAgentStreamLineObserved("copilot", JSON.stringify({ type: "assistant.message", data: { content: "done" } }));
      expect(getUnknownEventCounters().total).toBe(0);
    });

    it("treats deliberately-ignored copilot chatter as recognized-but-empty, not unknown", () => {
      const c = classifyAgentStreamLine("copilot", JSON.stringify({ type: "assistant.message_delta", data: { delta: "x" } }));
      expect(c.recognized).toBe(true);
      parseAgentStreamLineObserved("copilot", JSON.stringify({ type: "assistant.turn_start" }));
      expect(getUnknownEventCounters().total).toBe(0);
      expect(logged).toHaveLength(0);
    });

    it("does not misparse a foreign shape carrying a tool-name field as copilot tool activity", () => {
      const c = classifyAgentStreamLine("copilot", JSON.stringify({ type: "widget.updated", name: "not_a_tool" }));
      expect(c.recognized).toBe(false);
      expect(c.event?.toolActivity).toBeUndefined();
    });

    it("keeps the known copilot tool type names working", () => {
      const context = createAgentStreamParseContext();
      const start = classifyAgentStreamLine(
        "copilot",
        JSON.stringify({ type: "tool_call", id: "t1", name: "bash", arguments: { command: "ls" } }),
        context,
      );
      expect(start.recognized).toBe(true);
      expect(start.event?.toolActivity).toMatchObject({ name: "bash", toolUseId: "t1" });
      const done = classifyAgentStreamLine(
        "copilot",
        JSON.stringify({ type: "tool_call.completed", id: "t1", output: "ok" }),
        context,
      );
      expect(done.recognized).toBe(true);
      expect(done.event?.toolResult).toMatchObject({ toolUseId: "t1" });
    });
  });

  describe("codex usage-shape mismatch is recorded, not a silent zero (#976)", () => {
    it("records a mismatch when turn.completed carries an unrecognized usage shape", () => {
      const out = parseAgentProviderStreamLineObserved(
        "codex",
        JSON.stringify({ type: "turn.completed", usage: { tokens: { in: 500, out: 200 } } }),
      );
      // The turn still completes (no invented numbers beyond the typed zeros)...
      expect(out?.turnComplete).toBe(true);
      expect(out?.stats?.inputTokens).toBe(0);
      // ...but the shape drift is counted and logged through the shared path.
      expect(getUnknownEventCounters().counts.get("codex:turn.completed#usage-shape-mismatch")).toBe(1);
      expect(logged).toHaveLength(1);
      expect(logged[0].detail).toMatchObject({ provider: "codex", eventType: "turn.completed#usage-shape-mismatch" });
    });

    it("records a mismatch when usage is absent entirely", () => {
      parseAgentProviderStreamLineObserved("codex", JSON.stringify({ type: "turn.completed" }));
      expect(getUnknownEventCounters().counts.get("codex:turn.completed#usage-shape-mismatch")).toBe(1);
    });

    it("does not record when the nested total_token_usage shape matches", () => {
      const out = parseAgentProviderStreamLineObserved(
        "codex",
        JSON.stringify({ type: "turn.completed", usage: { total_token_usage: { input_tokens: 100, output_tokens: 50 } } }),
      );
      expect(out?.stats?.inputTokens).toBe(100);
      expect(getUnknownEventCounters().total).toBe(0);
      expect(logged).toHaveLength(0);
    });

    it("does not record when the flat usage shape matches, even at genuinely 0 tokens", () => {
      parseAgentProviderStreamLineObserved(
        "codex",
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0 } }),
      );
      expect(getUnknownEventCounters().total).toBe(0);
      expect(logged).toHaveLength(0);
    });
  });

  describe("per-provider threshold alert (#956)", () => {
    it("emits ONE alert naming the provider and sample types once the threshold is crossed", () => {
      // Distinct types so the per-key rate limit logs each first occurrence too;
      // the alert is the one containing "ALERT:".
      for (let i = 0; i < UNKNOWN_EVENT_ALERT_THRESHOLD; i++) {
        parseAgentProviderStreamLineObserved("codex", JSON.stringify({ type: i < 6 ? "renamed.common" : `renamed.rare_${i}` }));
      }
      const alerts = logged.filter((l) => l.message.includes("ALERT:"));
      expect(alerts).toHaveLength(1);
      expect(alerts[0].message).toContain("'codex'");
      expect(alerts[0].message).toContain(`${UNKNOWN_EVENT_ALERT_THRESHOLD} unknown stream events`);
      // Most frequent type is listed first among the samples.
      expect(alerts[0].message).toContain("renamed.common (6x)");
      expect(alerts[0].detail).toMatchObject({ provider: "codex", total: UNKNOWN_EVENT_ALERT_THRESHOLD });
      expect((alerts[0].detail.sampleTypes as string[]).length).toBeLessThanOrEqual(5);
    });

    it("does not re-alert for the same provider after the threshold", () => {
      const line = JSON.stringify({ type: "drift" });
      for (let i = 0; i < UNKNOWN_EVENT_ALERT_THRESHOLD * 3; i++) {
        parseAgentProviderStreamLineObserved("codex", line);
      }
      expect(logged.filter((l) => l.message.includes("ALERT:"))).toHaveLength(1);
    });

    it("stays silent below the threshold", () => {
      for (let i = 0; i < UNKNOWN_EVENT_ALERT_THRESHOLD - 1; i++) {
        parseAgentProviderStreamLineObserved("codex", JSON.stringify({ type: "drift" }));
      }
      expect(logged.filter((l) => l.message.includes("ALERT:"))).toHaveLength(0);
    });

    it("tracks providers independently and re-arms after reset", () => {
      for (let i = 0; i < UNKNOWN_EVENT_ALERT_THRESHOLD; i++) {
        parseAgentProviderStreamLineObserved("codex", JSON.stringify({ type: "drift" }));
        parseAgentProviderStreamLineObserved("claude", JSON.stringify({ type: "drift" }));
      }
      const alerts = logged.filter((l) => l.message.includes("ALERT:"));
      expect(alerts).toHaveLength(2);
      expect(alerts.map((a) => a.detail.provider).sort()).toEqual(["claude", "codex"]);

      resetUnknownEventCounters();
      logged.length = 0;
      for (let i = 0; i < UNKNOWN_EVENT_ALERT_THRESHOLD; i++) {
        parseAgentProviderStreamLineObserved("codex", JSON.stringify({ type: "drift" }));
      }
      expect(logged.filter((l) => l.message.includes("ALERT:"))).toHaveLength(1);
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
