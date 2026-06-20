import { describe, it, expect } from "vitest";
import {
  classifyTriggerType,
  buildReviewWorkspaces,
  attributeCommits,
  buildReviewResult,
  hasPositiveSeverity,
  computeDeepReviewSignals,
  type ReviewSessionRow,
  type ReviewWorkspace,
} from "../lib/review-effectiveness-report.js";

const GRACE = 2 * 60 * 1000;

function srow(o: Partial<ReviewSessionRow> & { sessionId: string; workspaceId: string; startedAt: string }): ReviewSessionRow {
  return {
    triggerType: null,
    endedAt: null,
    branch: "feature/x",
    wsStatus: "closed",
    provider: "claude",
    baseCommitSha: "base",
    mergedHeadSha: null,
    mergedAt: null,
    issueNumber: 7,
    issueTitle: "Title",
    ...o,
  };
}

describe("classifyTriggerType", () => {
  it("maps trigger types to lifecycle roles", () => {
    expect(classifyTriggerType(null)).toBe("build");
    expect(classifyTriggerType("review")).toBe("review");
    expect(classifyTriggerType("skill:code-review-thorough")).toBe("review");
    expect(classifyTriggerType("skill:board-monitor")).toBe("noise");
    expect(classifyTriggerType("fix-and-merge")).toBe("rework");
    expect(classifyTriggerType("verify")).toBe("other");
    expect(classifyTriggerType("anything-else")).toBe("build");
  });
});

describe("buildReviewWorkspaces", () => {
  const now = Date.parse("2026-06-20T12:00:00.000Z");

  it("drops noise sessions and flags workspaces that had a review", () => {
    const byWs = buildReviewWorkspaces([
      srow({ sessionId: "s1", workspaceId: "w1", startedAt: "2026-06-20T10:00:00.000Z", triggerType: null }),
      srow({ sessionId: "s2", workspaceId: "w1", startedAt: "2026-06-20T10:30:00.000Z", triggerType: "review" }),
      srow({ sessionId: "s3", workspaceId: "w1", startedAt: "2026-06-20T10:45:00.000Z", triggerType: "skill:board-monitor" }),
    ], now);
    const ws = byWs.get("w1")!;
    expect(ws.hasReview).toBe(true);
    expect(ws.sessions.map((s) => s.id)).toEqual(["s1", "s2"]); // s3 noise dropped
  });

  it("closes an open-ended window at the next session's start and the last at nowMs", () => {
    const byWs = buildReviewWorkspaces([
      srow({ sessionId: "s1", workspaceId: "w1", startedAt: "2026-06-20T10:00:00.000Z", endedAt: null }),
      srow({ sessionId: "s2", workspaceId: "w1", startedAt: "2026-06-20T10:20:00.000Z", endedAt: null, triggerType: "review" }),
    ], now);
    const [a, b] = byWs.get("w1")!.sessions;
    expect(a.end).toBe(Date.parse("2026-06-20T10:20:00.000Z")); // trimmed to s2 start
    expect(b.end).toBe(now); // last open window closes at now
  });

  it("prefers mergedHeadSha as the head ref and records merged state", () => {
    const byWs = buildReviewWorkspaces([
      srow({ sessionId: "s1", workspaceId: "w1", startedAt: "2026-06-20T10:00:00.000Z", mergedHeadSha: "deadbeef", mergedAt: "2026-06-20T11:00:00.000Z" }),
    ], now);
    const ws = byWs.get("w1")!;
    expect(ws.headRef).toBe("deadbeef");
    expect(ws.merged).toBe(true);
  });
});

describe("attributeCommits", () => {
  const ws: ReviewWorkspace = {
    workspaceId: "w1", issueNumber: 42, issueTitle: "t", provider: "claude", wsStatus: "closed",
    merged: true, baseCommitSha: "base", headRef: "head", hasReview: true,
    sessions: [
      { id: "build1", kind: "build", start: Date.parse("2026-06-20T10:00:00Z"), end: Date.parse("2026-06-20T10:30:00Z") },
      { id: "rev1", kind: "review", start: Date.parse("2026-06-20T11:00:00Z"), end: Date.parse("2026-06-20T11:30:00Z") },
    ],
  };

  it("attributes commits to the session whose window contains their author-time", () => {
    const attr = attributeCommits(ws, [
      { date: "2026-06-20T10:15:00Z", message: "impl work" },
      { date: "2026-06-20T11:10:00+02:00", message: "reviewer fix for #42" }, // tz offset, but instant is 09:10Z → unattributed
      { date: "2026-06-20T11:10:00Z", message: "reviewer fix for #42" },
    ], GRACE);
    expect(attr.implementerCommits).toBe(1);
    expect(attr.reviewerCommits).toBe(1);
    expect(attr.reviewerCommitsNamingIssue).toBe(1); // names #42
    expect(attr.unattributedCommits).toBe(1); // the +02:00 one falls outside every window
  });

  it("honors the grace window just after endedAt and ignores invalid dates", () => {
    const attr = attributeCommits(ws, [
      { date: "2026-06-20T11:31:00Z", message: "lands 1min after review end" }, // within 2min grace
      { date: "not-a-date", message: "garbage" },
    ], GRACE);
    expect(attr.reviewerCommits).toBe(1);
    expect(attr.unattributedCommits).toBe(1);
  });

  it("caps stored reviewer subjects at five", () => {
    const commits = Array.from({ length: 8 }, (_, i) => ({ date: "2026-06-20T11:10:00Z", message: `fix ${i}` }));
    const attr = attributeCommits(ws, commits, GRACE);
    expect(attr.reviewerCommits).toBe(8);
    expect(attr.reviewerCommitSubjects).toHaveLength(5);
  });
});

describe("buildReviewResult", () => {
  const ws: ReviewWorkspace = {
    workspaceId: "w1", issueNumber: 9, issueTitle: "A".repeat(80), provider: "codex", wsStatus: "closed",
    merged: false, baseCommitSha: "base", headRef: "head", hasReview: true,
    sessions: [{ id: "rev1", kind: "review", start: 0, end: 10_000 }],
  };

  it("folds identity + attribution and marks gitResolved by commit presence", () => {
    const res = buildReviewResult(ws, [{ date: new Date(5_000).toISOString(), message: "fix #9" }], GRACE);
    expect(res.issue).toBe(9);
    expect(res.title).toHaveLength(48); // truncated
    expect(res.gitResolved).toBe(true);
    expect(res.reviewerCommits).toBe(1);
    expect(res.reviewSessionIds).toEqual(["rev1"]);

    const empty = buildReviewResult(ws, [], GRACE);
    expect(empty.gitResolved).toBe(false);
  });
});

describe("hasPositiveSeverity", () => {
  it("matches a non-negated CRITICAL/MAJOR mention", () => {
    expect(hasPositiveSeverity("Found a CRITICAL bug in the parser")).toBe(true);
    expect(hasPositiveSeverity("one MAJOR concern remains")).toBe(true);
  });

  it("rejects negated mentions reviewers commonly write", () => {
    expect(hasPositiveSeverity("No CRITICAL or MAJOR issues found")).toBe(false);
    expect(hasPositiveSeverity("zero critical findings")).toBe(false);
    expect(hasPositiveSeverity("0 major problems")).toBe(false);
    expect(hasPositiveSeverity("")).toBe(false);
  });
});

describe("computeDeepReviewSignals", () => {
  it("flags edits, commits and severity across a workspace's review summaries", () => {
    const sig = computeDeepReviewSignals([
      { filesEdited: ["a.ts"] },
      { commandsRun: ["git commit -m x"], agentSummary: "a CRITICAL issue" },
    ], 0);
    expect(sig.reviewEdited).toBe(true);
    expect(sig.reviewCommitted).toBe(true);
    expect(sig.reviewMentionedMajorCritical).toBe(true);
    expect(sig.reviewFixedMajorCritical).toBe(true); // severity + (edited||committed)
  });

  it("counts a fix from git evidence alone when the transcript only cited severity", () => {
    const sig = computeDeepReviewSignals([{ agentSummary: "a MAJOR finding" }], 2);
    expect(sig.reviewEdited).toBe(false);
    expect(sig.reviewFixedMajorCritical).toBe(true); // reviewerCommits > 0
  });

  it("does not claim a fix when severity is cited but nothing happened", () => {
    const sig = computeDeepReviewSignals([{ agentSummary: "a MAJOR finding" }], 0);
    expect(sig.reviewMentionedMajorCritical).toBe(true);
    expect(sig.reviewFixedMajorCritical).toBe(false);
  });
});
