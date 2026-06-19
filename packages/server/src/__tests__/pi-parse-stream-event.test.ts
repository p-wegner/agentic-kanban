import { describe, it, expect } from "vitest";
import { PiProvider } from "../services/agent-provider/pi-provider.js";

// Characterization tests for PiProvider.parseStreamEvent (CC 62). Previously only
// the session-id header was tested; these pin each event-type branch so the parser
// can be safely decomposed into focused mutators.
const provider = new PiProvider();
const parse = (obj: unknown) => provider.parseStreamEvent(JSON.stringify(obj));

describe("PiProvider.parseStreamEvent", () => {
  it("returns undefined for non-JSON / fieldless input", () => {
    expect(provider.parseStreamEvent("not json")).toBeUndefined();
    expect(parse({ type: "noise" })).toBeUndefined();
  });

  it("extracts the provider session id from a session event", () => {
    expect(parse({ type: "session", id: "sess1" })?.providerSessionId).toBe("sess1");
  });

  describe("message_update assistant events", () => {
    it("captures a text_delta", () => {
      expect(parse({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } })?.assistantText).toBe("hi");
    });

    it("captures text_start/text_end content", () => {
      expect(parse({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "whole" } })?.assistantText).toBe("whole");
    });

    it("extracts a tool call from toolCall", () => {
      const evt = parse({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", toolCall: { name: "Edit", arguments: { path: "a" }, id: "tc1" } } });
      expect(evt?.toolActivity).toEqual({ name: "Edit", input: { path: "a" }, toolUseId: "tc1" });
    });

    it("falls back to partial.content[0] for a tool call", () => {
      const evt = parse({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", partial: { content: [{ name: "Read", arguments: {}, id: "tc2" }] } } });
      expect(evt?.toolActivity).toEqual({ name: "Read", input: {}, toolUseId: "tc2" });
    });
  });

  describe("message_start / message_end", () => {
    it("extracts a tool result from a toolResult message", () => {
      const evt = parse({ type: "message_start", message: { role: "toolResult", toolCallId: "tc3", content: "output" } });
      expect(evt?.toolResult).toEqual({ toolUseId: "tc3", agentResultText: "output" });
    });

    it("extracts assistant text from message content", () => {
      const evt = parse({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
      expect(evt?.assistantText).toBe("done");
    });
  });

  describe("tool execution events", () => {
    it("extracts tool activity from tool_execution_start", () => {
      const evt = parse({ type: "tool_execution_start", toolName: "Bash", args: { cmd: "ls" }, toolCallId: "tc4" });
      expect(evt?.toolActivity).toEqual({ name: "Bash", input: { cmd: "ls" }, toolUseId: "tc4" });
    });

    it("extracts tool result from tool_execution_end", () => {
      const evt = parse({ type: "tool_execution_end", toolCallId: "tc5", result: { content: "res" } });
      expect(evt?.toolResult).toEqual({ toolUseId: "tc5", agentResultText: "res" });
    });
  });

  describe("live stats", () => {
    it("derives model + contextTokens from a message usage block", () => {
      const evt = parse({ type: "message_update", message: { model: "pi-model", usage: { input: 10, cacheRead: 5 } }, assistantMessageEvent: {} });
      expect(evt?.liveStats).toEqual({ model: "pi-model", contextTokens: 15 });
    });
  });

  describe("turn_end", () => {
    it("builds stats + turnComplete", () => {
      const evt = parse({
        type: "turn_end",
        message: { model: "m", stopReason: "complete", usage: { input: 100, output: 20, cacheRead: 0, cost: { total: 0.3 } }, content: [{ type: "text", text: "summary" }] },
      });
      expect(evt?.turnComplete).toBe(true);
      expect(evt?.stats).toEqual({
        durationMs: 0,
        totalCostUsd: 0.3,
        inputTokens: 100,
        outputTokens: 20,
        contextTokens: 100,
        numTurns: 1,
        model: "m",
        success: true,
        agentSummary: "summary",
      });
    });

    it("flags rate limiting from a usage-limit error stopReason", () => {
      const evt = parse({ type: "turn_end", message: { stopReason: "error", errorMessage: "hit usage limit now" } });
      expect(evt?.stats?.success).toBe(false);
      expect(evt?.rateLimitInfo).toMatchObject({ status: "limited", rateLimitType: "usage_limit", message: "hit usage limit now" });
    });
  });

  it("extracts rate limit info from a rate_limit_event", () => {
    const evt = parse({ type: "rate_limit_event", rate_limit_info: { status: "limited", rateLimitType: "usage_limit", resetsAt: 123 } });
    expect(evt?.rateLimitInfo).toMatchObject({ status: "limited", rateLimitType: "usage_limit", resetsAt: 123 });
  });
});
