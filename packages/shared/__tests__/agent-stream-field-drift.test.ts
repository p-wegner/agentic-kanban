import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAgentStreamParseContext,
  parseAgentStreamLine,
  getUnknownFieldCounters,
  resetUnknownFieldCounters,
  setUnknownFieldLogger,
  setUnknownFieldClock,
  type UnknownFieldLogger,
} from "../src/lib/agent-stream-parser.js";

/**
 * Arch-review §2.2: inner-FIELD drift within a KNOWN Claude event type used to
 * parse as a silent 0/undefined — a usage-field rename zeroed contextTokens
 * (claude.ts:84), a content-shape change dropped assistantText (claude.ts:89) →
 * hadSubstantiveOutput false → completed runs misclassified as launch failures,
 * and a missing session_id (claude.ts:16) silently broke the resume chain. The
 * top-level unknown-EVENT detector never fires for these (the `type` still
 * matches). These tests assert the drift is now observable: counted through the
 * shared unknown-FIELD counters and (for session_id) loudly logged — while valid
 * events parse identically with zero drift.
 */
describe("agent-stream inner-field drift observability (claude)", () => {
  let logged: Array<{ message: string; detail: Record<string, unknown> }>;
  let restoreLogger: UnknownFieldLogger;
  let restoreClock: () => number;

  beforeEach(() => {
    resetUnknownFieldCounters();
    logged = [];
    restoreLogger = setUnknownFieldLogger((message, detail) => logged.push({ message, detail }));
    restoreClock = setUnknownFieldClock(() => 0);
  });

  afterEach(() => {
    setUnknownFieldLogger(restoreLogger);
    setUnknownFieldClock(restoreClock);
    resetUnknownFieldCounters();
  });

  const parse = (obj: unknown) => parseAgentStreamLine("claude", JSON.stringify(obj), createAgentStreamParseContext());

  describe("assistant usage-field rename (#976/#994 class)", () => {
    it("records assistant#usage drift instead of a silent 0 when the token fields are renamed", () => {
      const event = parse({
        type: "assistant",
        message: {
          model: "claude-opus-4",
          // renamed: prompt_tokens/completion_tokens instead of input_tokens/cache_read_input_tokens
          usage: { prompt_tokens: 100, completion_tokens: 50 },
          content: [{ type: "text", text: "done" }],
        },
      });
      // The happy path still yields the text (parser degrades observably, not silently)...
      expect(event?.assistantText).toBe("done");
      // ...but contextTokens read as the tell-tale silent 0, now made observable.
      expect(event?.liveStats?.contextTokens ?? 0).toBe(0);
      const { counts, total } = getUnknownFieldCounters();
      expect(total).toBe(1);
      expect(counts.get("claude:assistant#usage")).toBe(1);
      expect(logged).toHaveLength(1);
      expect(logged[0].message.toLowerCase()).toContain("field drift");
      expect(logged[0].detail).toMatchObject({ provider: "claude", eventType: "assistant#usage" });
    });

    it("does NOT record when the usage token fields are present (even at a genuine 0)", () => {
      const event = parse({
        type: "assistant",
        message: {
          model: "m",
          usage: { input_tokens: 0, cache_read_input_tokens: 0 },
          content: [{ type: "text", text: "hi" }],
        },
      });
      expect(event?.assistantText).toBe("hi");
      expect(getUnknownFieldCounters().total).toBe(0);
      expect(logged).toHaveLength(0);
    });

    it("does NOT record for a tool_use-only assistant message that carries no usage (healthy)", () => {
      // A tool_use-only turn legitimately omits usage — an ABSENT usage object is
      // NOT drift; only a present-but-renamed one is.
      parse({
        type: "assistant",
        message: { model: "m", content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] },
      });
      expect(getUnknownFieldCounters().total).toBe(0);
      expect(logged).toHaveLength(0);
    });
  });

  describe("assistant content-shape drift (assistantText → hadSubstantiveOutput cascade)", () => {
    it("records assistant#content drift when content is no longer the expected block array", () => {
      const event = parse({
        type: "assistant",
        message: {
          model: "m",
          usage: { input_tokens: 5, cache_read_input_tokens: 1 },
          // shape drift: content is a bare string instead of an array of blocks
          content: "all done",
        },
      });
      // No assistantText extracted — the exact silent drop that flips
      // hadSubstantiveOutput false — but now the drift is counted.
      expect(event?.assistantText).toBeUndefined();
      const { counts } = getUnknownFieldCounters();
      expect(counts.get("claude:assistant#content")).toBe(1);
      // usage was fine, so ONLY the content drift is recorded.
      expect(counts.get("claude:assistant#usage")).toBeUndefined();
      expect(logged.some((l) => l.detail.eventType === "assistant#content")).toBe(true);
    });

    it("does NOT record when content is a valid (even empty) block array", () => {
      parse({
        type: "assistant",
        message: { model: "m", usage: { input_tokens: 5, cache_read_input_tokens: 1 }, content: [] },
      });
      expect(getUnknownFieldCounters().total).toBe(0);
      expect(logged).toHaveLength(0);
    });
  });

  describe("system/init missing session_id (fail loud on resume-chain break)", () => {
    it("records system.init drift AND logs a clear resume-chain warning", () => {
      const event = parse({
        type: "system",
        subtype: "init",
        model: "m",
        cwd: "/repo",
        tools: [],
        // no session_id — a rename reads identically to "no session id"
      });
      // Degrades observably: no providerSessionId, but the init display event
      // is still emitted (the parser does not crash).
      expect(event?.providerSessionId).toBeUndefined();
      expect(event?.displayEvents?.some((e) => e.kind === "init")).toBe(true);
      expect(getUnknownFieldCounters().counts.get("claude:system.init")).toBe(1);
      expect(logged).toHaveLength(1);
      const detailText = String(logged[0].detail.detail);
      expect(detailText).toContain("session_id");
      expect(detailText.toLowerCase()).toContain("resume");
    });

    it("does NOT record when the init event carries a session_id", () => {
      const event = parse({
        type: "system",
        subtype: "init",
        session_id: "sess-123",
        model: "m",
        cwd: "/repo",
        tools: [],
      });
      expect(event?.providerSessionId).toBe("sess-123");
      expect(getUnknownFieldCounters().total).toBe(0);
      expect(logged).toHaveLength(0);
    });
  });
});
