import { describe, it, expect } from "vitest";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import {
  detectClaudeUsageLimitText,
  detectClaudeUsageLimitMessages,
  isClaudeUsageLimitStats,
} from "../services/claude-rate-limit.js";

function msg(data: string): AgentOutputMessage {
  return { type: "stdout", data } as AgentOutputMessage;
}

describe("detectClaudeUsageLimitText", () => {
  it("matches the human-readable usage-limit message + reset hint", () => {
    const info = detectClaudeUsageLimitText("Claude usage limit reached. Your limit will reset at 3pm.");
    expect(info).not.toBeNull();
    expect(info?.resetsAt).toBe("3pm");
  });

  it("matches the 5-hour and weekly limit phrasings", () => {
    expect(detectClaudeUsageLimitText("5-hour limit reached")).not.toBeNull();
    expect(detectClaudeUsageLimitText("Weekly limit reached")).not.toBeNull();
  });

  it("returns null for unrelated text", () => {
    expect(detectClaudeUsageLimitText("Build succeeded")).toBeNull();
    expect(detectClaudeUsageLimitText(undefined)).toBeNull();
  });
});

describe("detectClaudeUsageLimitMessages", () => {
  it("detects a rejected rate_limit_event with epoch resetsAt", () => {
    const epoch = Math.floor(new Date("2026-06-07T17:00:00Z").getTime() / 1000);
    const line = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: epoch } });
    const info = detectClaudeUsageLimitMessages([msg(line)]);
    expect(info).not.toBeNull();
    expect(info?.resetsAt).toBe("2026-06-07T17:00:00.000Z");
  });

  it("detects a usage limit inside a result event's result string", () => {
    const line = JSON.stringify({ type: "result", result: "Claude usage limit reached. reset at 9am" });
    expect(detectClaudeUsageLimitMessages([msg(line)])).not.toBeNull();
  });

  it("ignores an allowed_warning rate_limit_event", () => {
    const line = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1 } });
    expect(detectClaudeUsageLimitMessages([msg(line)])).toBeNull();
  });
});

describe("isClaudeUsageLimitStats", () => {
  it("recognizes the claude-usage-limit stats marker", () => {
    expect(isClaudeUsageLimitStats(JSON.stringify({ rateLimited: true, rateLimitKind: "claude-usage-limit" }))).toBe(true);
  });
  it("rejects codex / non-rate-limit stats", () => {
    expect(isClaudeUsageLimitStats(JSON.stringify({ rateLimited: true, rateLimitKind: "codex-usage-limit" }))).toBe(false);
    expect(isClaudeUsageLimitStats(JSON.stringify({ success: true }))).toBe(false);
    expect(isClaudeUsageLimitStats(null)).toBe(false);
  });
});
