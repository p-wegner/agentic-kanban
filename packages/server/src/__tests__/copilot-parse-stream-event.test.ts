import { describe, it, expect } from "vitest";
import { CopilotProvider } from "../services/agent-provider/copilot-provider.js";

// Characterization tests for CopilotProvider.parseStreamEvent. This parser was
// previously untested (CC 106) and feeds every Copilot agent session. These tests
// pin the current behaviour of each extraction branch so the function can be safely
// decomposed into pure per-field helpers.
const provider = new CopilotProvider();
const parse = (obj: unknown) => provider.parseStreamEvent(JSON.stringify(obj));

describe("CopilotProvider.parseStreamEvent", () => {
  it("returns undefined for non-JSON / empty input", () => {
    expect(provider.parseStreamEvent("not json")).toBeUndefined();
    expect(provider.parseStreamEvent("")).toBeUndefined();
  });

  it("returns undefined when no field can be extracted", () => {
    expect(parse({ type: "noise" })).toBeUndefined();
  });

  describe("provider session id", () => {
    it("extracts an explicit session_id from the top-level object", () => {
      const evt = parse({ type: "foo", session_id: "s1" });
      expect(evt?.providerSessionId).toBe("s1");
      expect(evt?.liveStats).toBeUndefined();
    });

    it("falls back to obj.id only for session-id-bearing event types", () => {
      expect(parse({ type: "session.started", id: "s2" })?.providerSessionId).toBe("s2");
      // a non-session event type must NOT treat obj.id as the session id
      expect(parse({ type: "noise", id: "nope" })?.providerSessionId).toBeUndefined();
    });

    it("reads nested session.id", () => {
      expect(parse({ type: "foo", session: { id: "s3" } })?.providerSessionId).toBe("s3");
    });
  });

  describe("live stats", () => {
    it("derives contextTokens from input + cached tokens", () => {
      const evt = parse({ type: "x", model: "gpt", usage: { input_tokens: 10, cached_input_tokens: 5 } });
      expect(evt?.liveStats).toEqual({ model: "gpt", contextTokens: 15 });
    });

    it("emits liveStats when only a model is present", () => {
      const evt = parse({ type: "x", model: "m" });
      expect(evt?.liveStats).toEqual({ model: "m", contextTokens: 0 });
    });
  });

  describe("data wrapper", () => {
    it("prefers the nested data payload over the top-level object", () => {
      const evt = parse({ type: "x", data: { session_id: "d1", model: "m" } });
      expect(evt?.providerSessionId).toBe("d1");
      expect(evt?.liveStats).toEqual({ model: "m", contextTokens: 0 });
    });
  });

  describe("turn completion stats", () => {
    it("builds stats + turnComplete on a result event", () => {
      const evt = parse({
        type: "result",
        duration_ms: 1234,
        total_cost_usd: 0.5,
        usage: { input_tokens: 100, output_tokens: 20 },
        num_turns: 3,
        model: "gpt",
        result: "done",
      });
      expect(evt?.turnComplete).toBe(true);
      expect(evt?.stats).toEqual({
        durationMs: 1234,
        totalCostUsd: 0.5,
        inputTokens: 100,
        outputTokens: 20,
        numTurns: 3,
        model: "gpt",
        success: true,
        agentSummary: "done",
      });
    });

    it("marks success false when is_error is set", () => {
      const evt = parse({ type: "completed", is_error: true });
      expect(evt?.stats?.success).toBe(false);
      expect(evt?.stats?.numTurns).toBe(1);
    });
  });

  describe("tool activity", () => {
    it("extracts a tool call from tool_name + input + tool_use_id", () => {
      const evt = parse({ type: "tool", tool_name: "edit", input: { path: "a" }, tool_use_id: "t1" });
      expect(evt?.toolActivity).toEqual({ name: "edit", input: { path: "a" }, toolUseId: "t1" });
    });

    it("maps a command execution to a shell tool", () => {
      const evt = parse({ type: "command", command: "ls", id: "c1" });
      expect(evt?.toolActivity).toEqual({ name: "shell", input: { command: "ls" }, toolUseId: "c1" });
    });

    it("handles tool.execution_start with default tool name", () => {
      const evt = parse({ type: "tool.execution_start", toolCallId: "tc2", arguments: {} });
      expect(evt?.toolActivity).toEqual({ name: "copilot_tool", input: {}, toolUseId: "tc2" });
    });
  });

  describe("tool result", () => {
    it("extracts a tool result on a tool.completed event", () => {
      const evt = parse({ type: "tool.completed", tool_use_id: "t9" });
      expect(evt?.toolResult).toEqual({ toolUseId: "t9" });
    });
  });

  describe("assistant text", () => {
    it("extracts direct text", () => {
      expect(parse({ type: "assistant", text: "hello" })?.assistantText).toBe("hello");
    });

    it("joins text blocks from a content array", () => {
      expect(parse({ type: "x", content: [{ text: "a" }, { text: "b" }] })?.assistantText).toBe("a\nb");
    });
  });
});
