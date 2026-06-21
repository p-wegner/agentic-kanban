import { describe, it, expect } from "vitest";
import {
  countAskFollowupQuestions,
  computeFileOverlapCounts,
  isFailedRiskSession,
  parseConflictCache,
  parseDiffStatCache,
  selectLastSessionAt,
} from "./workspace-risk-signals.js";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const baseSession = {
  startedAt: ago(60_000),
  endedAt: ago(0),
  status: "stopped",
  exitCode: "0" as string | null,
  stats: JSON.stringify({ inputTokens: 100, outputTokens: 50 }),
};

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

describe("isFailedRiskSession", () => {
  it("never flags a running session (no endedAt)", () => {
    expect(isFailedRiskSession({ ...baseSession, status: "running", endedAt: null, exitCode: null })).toBe(false);
  });

  it("flags a stopped session with a non-zero exit code", () => {
    expect(isFailedRiskSession({ ...baseSession, status: "stopped", exitCode: "1" })).toBe(true);
  });

  it("does not flag a stopped exit-0 session with real token output and >1s duration", () => {
    expect(isFailedRiskSession({
      startedAt: "2026-06-03T12:00:00.000Z",
      endedAt: "2026-06-03T12:05:00.000Z",
      status: "stopped",
      exitCode: "0",
      stats: JSON.stringify({ inputTokens: 100, outputTokens: 50 }),
    })).toBe(false);
  });

  it("flags a sub-second (<=1s) session as zero-output regardless of tokens", () => {
    expect(isFailedRiskSession({
      startedAt: "2026-06-03T12:00:00.000Z",
      endedAt: "2026-06-03T12:00:00.800Z",
      status: "stopped",
      exitCode: "0",
      stats: JSON.stringify({ inputTokens: 999, outputTokens: 999 }),
    })).toBe(true);
  });

  it("flags a long session with null stats as zero-output", () => {
    expect(isFailedRiskSession({
      startedAt: "2026-06-03T12:00:00.000Z",
      endedAt: "2026-06-03T12:05:00.000Z",
      status: "stopped",
      exitCode: "0",
      stats: null,
    })).toBe(true);
  });

  it("flags a long session with explicit zero tokens as zero-output", () => {
    expect(isFailedRiskSession({
      startedAt: "2026-06-03T12:00:00.000Z",
      endedAt: "2026-06-03T12:05:00.000Z",
      status: "stopped",
      exitCode: "0",
      stats: JSON.stringify({ inputTokens: 0, outputTokens: 0 }),
    })).toBe(true);
  });

  it("requires BOTH token counts to be zero/absent (one non-zero is not zero-output)", () => {
    expect(isFailedRiskSession({
      startedAt: "2026-06-03T12:00:00.000Z",
      endedAt: "2026-06-03T12:05:00.000Z",
      status: "stopped",
      exitCode: "0",
      stats: JSON.stringify({ inputTokens: 5, outputTokens: 0 }),
    })).toBe(false);
  });

  it("treats malformed stats JSON as non-zero-output (parse failure -> not a failure)", () => {
    expect(isFailedRiskSession({
      startedAt: "2026-06-03T12:00:00.000Z",
      endedAt: "2026-06-03T12:05:00.000Z",
      status: "stopped",
      exitCode: "0",
      stats: "{not json",
    })).toBe(false);
  });
});

describe("selectLastSessionAt", () => {
  it("returns null when there is no session", () => {
    expect(selectLastSessionAt(null)).toBeNull();
  });

  it("uses startedAt for a running session", () => {
    expect(selectLastSessionAt({ status: "running", startedAt: "S", endedAt: "E" })).toBe("S");
  });

  it("uses endedAt for a non-running session", () => {
    expect(selectLastSessionAt({ status: "stopped", startedAt: "S", endedAt: "E" })).toBe("E");
    expect(selectLastSessionAt({ status: "stopped", startedAt: "S", endedAt: null })).toBeNull();
  });
});

describe("parseConflictCache", () => {
  const base = {
    conflictCacheCheckedAt: "2026-06-03T12:00:00.000Z",
    conflictCacheHasConflicts: true as boolean | null,
    conflictCacheFiles: JSON.stringify(["a.ts", "b.ts"]),
  };

  it("returns null when the cache was never checked", () => {
    expect(parseConflictCache({ ...base, conflictCacheCheckedAt: null })).toBeNull();
  });

  it("returns null when hasConflicts is null (unknown)", () => {
    expect(parseConflictCache({ ...base, conflictCacheHasConflicts: null })).toBeNull();
  });

  it("parses conflicting files when flagged", () => {
    expect(parseConflictCache(base)).toEqual({ hasConflicts: true, conflictingFiles: ["a.ts", "b.ts"] });
  });

  it("reports hasConflicts:false with empty files (default '[]') when not conflicted", () => {
    expect(parseConflictCache({ ...base, conflictCacheHasConflicts: false, conflictCacheFiles: null }))
      .toEqual({ hasConflicts: false, conflictingFiles: [] });
  });

  it("degrades malformed file JSON to an empty list but stays flagged", () => {
    expect(parseConflictCache({ ...base, conflictCacheFiles: "{bad" }))
      .toEqual({ hasConflicts: true, conflictingFiles: [] });
  });
});

describe("parseDiffStatCache", () => {
  const base = {
    diffStatCacheCheckedAt: "2026-06-03T12:00:00.000Z",
    diffStatCacheFilesChanged: 8 as number | null,
    diffStatCacheInsertions: 50 as number | null,
    diffStatCacheDeletions: 20 as number | null,
  };

  it("returns null when the cache was never checked", () => {
    expect(parseDiffStatCache({ ...base, diffStatCacheCheckedAt: null })).toBeNull();
  });

  it("returns null when filesChanged is null", () => {
    expect(parseDiffStatCache({ ...base, diffStatCacheFilesChanged: null })).toBeNull();
  });

  it("parses the diff-stat triple", () => {
    expect(parseDiffStatCache(base)).toEqual({ filesChanged: 8, insertions: 50, deletions: 20 });
  });

  it("defaults null insertions/deletions to 0", () => {
    expect(parseDiffStatCache({ ...base, diffStatCacheInsertions: null, diffStatCacheDeletions: null }))
      .toEqual({ filesChanged: 8, insertions: 0, deletions: 0 });
  });
});
