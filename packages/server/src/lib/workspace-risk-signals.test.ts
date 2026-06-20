import { describe, it, expect } from "vitest";
import { countAskFollowupQuestions, computeFileOverlapCounts } from "./workspace-risk-signals.js";

function assistantWithTools(...tools: string[]): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: tools.map((name) => ({ type: "tool_use", name })) },
  });
}

describe("countAskFollowupQuestions", () => {
  it("returns 0 for empty or junk input", () => {
    expect(countAskFollowupQuestions("")).toBe(0);
    expect(countAskFollowupQuestions("not json\n{also bad")).toBe(0);
  });

  it("counts ask_followup_question tool_use blocks across JSONL lines", () => {
    const data = [
      assistantWithTools("Bash"),
      assistantWithTools("ask_followup_question", "Read"),
      "   ",
      assistantWithTools("ask_followup_question"),
    ].join("\n");
    expect(countAskFollowupQuestions(data)).toBe(2);
  });

  it("ignores non-assistant events and tolerates missing content", () => {
    const data = [
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_use", name: "ask_followup_question" }] } }),
      JSON.stringify({ type: "assistant" }),
      JSON.stringify({ type: "assistant", message: {} }),
    ].join("\n");
    expect(countAskFollowupQuestions(data)).toBe(0);
  });
});

describe("computeFileOverlapCounts", () => {
  it("returns 0 for each workspace when there is no overlap", () => {
    const m = new Map([
      ["a", ["x.ts"]],
      ["b", ["y.ts"]],
    ]);
    expect([...computeFileOverlapCounts(m)]).toEqual([["a", 0], ["b", 0]]);
  });

  it("counts each other workspace at most once regardless of shared file count", () => {
    const m = new Map([
      ["a", ["x.ts", "z.ts"]],
      ["b", ["x.ts", "z.ts"]], // shares two files with a -> still counts as 1
      ["c", ["q.ts"]],
    ]);
    const out = computeFileOverlapCounts(m);
    expect(out.get("a")).toBe(1);
    expect(out.get("b")).toBe(1);
    expect(out.get("c")).toBe(0);
  });

  it("counts overlap with multiple distinct workspaces", () => {
    const m = new Map([
      ["a", ["x.ts"]],
      ["b", ["x.ts"]],
      ["c", ["x.ts"]],
    ]);
    const out = computeFileOverlapCounts(m);
    expect(out.get("a")).toBe(2);
    expect(out.get("b")).toBe(2);
    expect(out.get("c")).toBe(2);
  });

  it("handles empty file lists and an empty map", () => {
    expect([...computeFileOverlapCounts(new Map())]).toEqual([]);
    const m = new Map([["a", []], ["b", ["x.ts"]]]);
    expect(computeFileOverlapCounts(m).get("a")).toBe(0);
    expect(computeFileOverlapCounts(m).get("b")).toBe(0);
  });
});
