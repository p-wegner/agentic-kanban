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

  it("#488: does not fire on a Read-tool result echoing its own rate-limit source as one escaped-JSON line", () => {
    // A Read tool result arrives as a single JSON line with the file's newlines escaped as
    // literal \n, so "usage limit" and "reset" from unrelated parts of the file can satisfy an
    // unbounded regex across the whole blob. This must never be text-matched.
    const fileText =
      "export const CLAUDE_USAGE_LIMIT_PATTERN = /usage limit.*reset/i;\\n".repeat(3) +
      "/** Extract the \\\"try again / resets at X\\\" hint persisted on the rate-limited session's stats. More unrelated prose follows for a long stretch before anything resembling a reset ever appears again in this comment block, well past any reasonable bound. */";
    const toolResultLine = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: fileText }] },
    });
    expect(detectClaudeUsageLimitMessages([msg(toolResultLine)])).toBeNull();
  });

  it("#488: an authoritative allowed rate_limit_event wins even when a (guarded) tool-result line is present", () => {
    const toolResultLine = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "usage limit reached, reset at 3pm" }] },
    });
    const rateLimitLine = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 1786821600, rateLimitType: "five_hour" },
    });
    expect(detectClaudeUsageLimitMessages([msg(toolResultLine), msg(rateLimitLine)])).toBeNull();
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

describe("#488 defence 4: an unparseable reset hint is rejected, not persisted", () => {
  it("stores null rather than prose when the capture is not a time", () => {
    // The exact shape seen live: the greedy capture grabbed doc-comment prose and it was
    // written into the session's retryAfter field.
    const info = detectClaudeUsageLimitText('5-hour limit reached. resets at X" hint persisted on the stats');
    expect(info).not.toBeNull();
    expect(info?.resetsAt).toBeNull();
  });

  it("still accepts genuine clock-ish and parseable hints", () => {
    expect(detectClaudeUsageLimitText("Claude usage limit reached. reset at 3pm.")?.resetsAt).toBe("3pm");
    expect(detectClaudeUsageLimitText("Claude usage limit reached. reset at 15:00.")?.resetsAt).toBe("15:00");
  });
});
