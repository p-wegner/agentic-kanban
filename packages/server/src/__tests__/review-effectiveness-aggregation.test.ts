import { describe, it, expect } from "vitest";
import {
  classifyTrigger,
  parseSessionStats,
  aggregateReviewWorkspaceStats,
  bucketScorecardScores,
  classifyReviewVerdictText,
  type ReviewEffSessionInput,
} from "../lib/review-effectiveness-aggregation.js";

/** Build a session row with sensible defaults; override only what a case exercises. */
function row(over: Partial<ReviewEffSessionInput> = {}): ReviewEffSessionInput {
  return {
    sessionId: "s1",
    triggerType: "agent",
    startedAt: "2026-01-01T00:00:00.000Z",
    stats: null,
    workspaceId: "ws1",
    branch: "feature/x",
    wsStatus: "idle",
    provider: "claude",
    mergedAt: null,
    readyForMerge: false,
    requiresReview: false,
    scorecardScore: null,
    issueNumber: 1,
    issueTitle: "T",
    issueType: "task",
    ...over,
  };
}

describe("classifyTrigger", () => {
  it.each<[string | null, string]>([
    ["review", "review"],
    ["skill:code-review", "review"],
    ["skill:code-review-thorough", "review"],
    ["skill:board-monitor", "noise"],
    ["skill:board-navigator", "noise"],
    ["chat", "rework"],
    ["fix-and-merge", "rework"],
    ["fix-conflicts", "rework"],
    ["plan-reject", "rework"],
    ["verify", "other"],
    ["learning", "other"],
    ["bisect", "other"],
    ["reconcile", "other"],
    ["agent", "build"],
    ["auto-start", "build"],
    ["plan-implement", "build"],
    ["skill:something-else", "build"],
    [null, "build"],
  ])("classifies %s -> %s", (trigger, kind) => {
    expect(classifyTrigger(trigger)).toBe(kind);
  });
});

describe("parseSessionStats", () => {
  it("returns zeros for null / invalid JSON", () => {
    expect(parseSessionStats(null)).toEqual({ cost: 0, durationMs: 0, turns: 0 });
    expect(parseSessionStats("not json")).toEqual({ cost: 0, durationMs: 0, turns: 0 });
  });

  it("reads totalCostUsd / durationMs / numTurns when numeric", () => {
    expect(parseSessionStats(JSON.stringify({ totalCostUsd: 1.5, durationMs: 2000, numTurns: 3 }))).toEqual({
      cost: 1.5,
      durationMs: 2000,
      turns: 3,
    });
  });

  it("ignores non-numeric fields (defaults each to 0)", () => {
    expect(parseSessionStats(JSON.stringify({ totalCostUsd: "1", numTurns: null }))).toEqual({
      cost: 0,
      durationMs: 0,
      turns: 0,
    });
  });
});

describe("bucketScorecardScores", () => {
  it("buckets scores into the four descending bands by boundary", () => {
    // boundaries: >=90, >=75, >=60, else
    expect(bucketScorecardScores([100, 90, 89, 75, 74, 60, 59, 0])).toEqual({
      "90-100": 2, // 100, 90
      "75-89": 2, // 89, 75
      "60-74": 2, // 74, 60
      "<60": 2, // 59, 0
    });
  });

  it("is all-zero for an empty input", () => {
    expect(bucketScorecardScores([])).toEqual({ "90-100": 0, "75-89": 0, "60-74": 0, "<60": 0 });
  });
});

describe("classifyReviewVerdictText", () => {
  it("returns changesRequested when only a changes signal fires", () => {
    expect(classifyReviewVerdictText("Found a CRITICAL issue, moving back to in progress")).toBe("changesRequested");
  });

  it("returns approve when only an approve signal fires", () => {
    expect(classifyReviewVerdictText("LGTM — ready for merge")).toBe("approve");
  });

  it("resolves approve when BOTH signals fire (original tie-break)", () => {
    expect(classifyReviewVerdictText("approved, but there was a critical issue earlier")).toBe("approve");
  });

  it("returns unclear when neither signal fires", () => {
    expect(classifyReviewVerdictText("I looked at the diff and ran the tests.")).toBe("unclear");
  });

  it("is case-insensitive (lower-cases internally)", () => {
    expect(classifyReviewVerdictText("READY FOR MERGE")).toBe("approve");
  });
});

describe("aggregateReviewWorkspaceStats", () => {
  it("returns empty map + dist for no rows", () => {
    const { byWs, triggerDist } = aggregateReviewWorkspaceStats([], []);
    expect(byWs.size).toBe(0);
    expect(triggerDist).toEqual({});
  });

  it("tallies the triggerType distribution including noise (null bucketed as '(null)')", () => {
    const { triggerDist } = aggregateReviewWorkspaceStats(
      [
        row({ triggerType: "agent" }),
        row({ triggerType: "agent" }),
        row({ triggerType: null }),
        row({ triggerType: "skill:board-monitor" }),
      ],
      [],
    );
    expect(triggerDist).toEqual({ agent: 2, "(null)": 1, "skill:board-monitor": 1 });
  });

  it("does NOT create a workspace entry for a noise-only session", () => {
    const { byWs } = aggregateReviewWorkspaceStats([row({ triggerType: "skill:board-monitor" })], []);
    expect(byWs.size).toBe(0);
  });

  it("counts build, review and rework runs and splits their cost", () => {
    const { byWs } = aggregateReviewWorkspaceStats(
      [
        row({ sessionId: "a", triggerType: "agent", stats: JSON.stringify({ totalCostUsd: 1.0, durationMs: 100 }) }),
        row({ sessionId: "b", triggerType: "review", startedAt: "2026-01-01T01:00:00.000Z", stats: JSON.stringify({ totalCostUsd: 0.2, durationMs: 50 }) }),
        row({ sessionId: "c", triggerType: "fix-and-merge", startedAt: "2026-01-01T02:00:00.000Z", stats: JSON.stringify({ totalCostUsd: 0.5 }) }),
      ],
      [],
    );
    const ws = byWs.get("ws1")!;
    expect(ws.builds).toBe(1);
    expect(ws.reviews).toBe(1);
    expect(ws.reworks).toBe(1);
    expect(ws.reviewCost).toBeCloseTo(0.2, 5);
    expect(ws.buildCost).toBeCloseTo(1.5, 5); // build 1.0 + rework 0.5
    expect(ws.reviewDurationMs).toBe(50);
    expect(ws.reviewSessionIds).toEqual(["b"]);
    expect(ws.firstReviewAt).toBe("2026-01-01T01:00:00.000Z");
    expect(ws.lastReviewAt).toBe("2026-01-01T01:00:00.000Z");
  });

  it("flags changeAfterReview when a build/rework starts AFTER the first review (bounce-back)", () => {
    const { byWs } = aggregateReviewWorkspaceStats(
      [
        row({ sessionId: "a", triggerType: "agent", startedAt: "2026-01-01T00:00:00.000Z" }),
        row({ sessionId: "b", triggerType: "review", startedAt: "2026-01-01T01:00:00.000Z" }),
        row({ sessionId: "c", triggerType: "agent", startedAt: "2026-01-01T02:00:00.000Z" }),
      ],
      [],
    );
    expect(byWs.get("ws1")!.changeAfterReview).toBe(true);
  });

  it("does NOT flag changeAfterReview when the build precedes the review", () => {
    const { byWs } = aggregateReviewWorkspaceStats(
      [
        row({ sessionId: "a", triggerType: "agent", startedAt: "2026-01-01T00:00:00.000Z" }),
        row({ sessionId: "b", triggerType: "review", startedAt: "2026-01-01T01:00:00.000Z" }),
      ],
      [],
    );
    expect(byWs.get("ws1")!.changeAfterReview).toBe(false);
  });

  it("attaches comment totals/resolved from the comment rows to the first-seen workspace", () => {
    const { byWs } = aggregateReviewWorkspaceStats(
      [row({ workspaceId: "ws1", triggerType: "review" })],
      [
        { workspaceId: "ws1", resolvedAt: "2026-01-01T00:00:00.000Z" },
        { workspaceId: "ws1", resolvedAt: null },
        { workspaceId: "ws-other", resolvedAt: null },
      ],
    );
    const ws = byWs.get("ws1")!;
    expect(ws.comments).toBe(2);
    expect(ws.commentsResolved).toBe(1);
  });

  it("groups multiple workspaces independently", () => {
    const { byWs } = aggregateReviewWorkspaceStats(
      [
        row({ workspaceId: "ws1", triggerType: "agent" }),
        row({ workspaceId: "ws2", triggerType: "review" }),
      ],
      [],
    );
    expect(byWs.size).toBe(2);
    expect(byWs.get("ws1")!.builds).toBe(1);
    expect(byWs.get("ws2")!.reviews).toBe(1);
  });
});
