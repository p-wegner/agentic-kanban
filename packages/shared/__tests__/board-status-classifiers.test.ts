import { describe, expect, it } from "vitest";
import type { BoardStatusIssue } from "../src/types/api.js";
import {
  classifyBoardStatusIssueAttention,
  classifyBoardStatusIssueMergeState,
} from "../src/lib/board-status-classifiers.js";

// Minimal BoardStatusIssue builder — the classifiers only read statusName, workspace
// (status/readyForMerge), diffStats and mergeState.
function issue(over: Partial<BoardStatusIssue>): BoardStatusIssue {
  return {
    statusName: "In Review",
    workspace: { status: "idle", readyForMerge: false } as BoardStatusIssue["workspace"],
    diffStats: { filesChanged: 0, insertions: 0, deletions: 0 } as BoardStatusIssue["diffStats"],
    mergeState: null,
    attention: null,
    ...over,
  } as BoardStatusIssue;
}

describe("classifyBoardStatusIssueAttention", () => {
  // The MCP fork previously only emitted "idle-awaiting" — assert all three buckets are
  // reachable so the dedup can never silently re-drift to a single-bucket implementation.
  it("flags closed-in-review (workspace points at a closed/merged workspace)", () => {
    const a = classifyBoardStatusIssueAttention(
      issue({ workspace: { status: "closed", readyForMerge: false } as BoardStatusIssue["workspace"] }),
    );
    expect(a?.reason).toBe("closed-in-review");
  });

  it("flags stale-in-review (no diff stats available)", () => {
    const a = classifyBoardStatusIssueAttention(issue({ diffStats: null }));
    expect(a?.reason).toBe("stale-in-review");
  });

  it("flags idle-awaiting (zero-diff workspace not ready)", () => {
    const a = classifyBoardStatusIssueAttention(issue({}));
    expect(a?.reason).toBe("idle-awaiting");
  });

  it("returns null when the workspace is pending an auto-merge", () => {
    const a = classifyBoardStatusIssueAttention(
      issue({ mergeState: { bucket: "pending_merge", reason: "auto-merge-in-review", label: "x" } }),
    );
    expect(a).toBeNull();
  });

  it("returns null for a healthy In Review workspace with real diff", () => {
    const a = classifyBoardStatusIssueAttention(
      issue({ diffStats: { filesChanged: 3, insertions: 10, deletions: 2 } as BoardStatusIssue["diffStats"] }),
    );
    expect(a).toBeNull();
  });

  it("returns null when readyForMerge", () => {
    const a = classifyBoardStatusIssueAttention(
      issue({ workspace: { status: "idle", readyForMerge: true } as BoardStatusIssue["workspace"] }),
    );
    expect(a).toBeNull();
  });
});

describe("classifyBoardStatusIssueMergeState", () => {
  const opts = { autoMergeEnabled: true, autoMergeInReview: true };

  it("flags pending_merge for an idle In Review workspace with a real diff", () => {
    const m = classifyBoardStatusIssueMergeState(
      issue({ diffStats: { filesChanged: 1, insertions: 1, deletions: 0 } as BoardStatusIssue["diffStats"] }),
      opts,
    );
    expect(m?.bucket).toBe("pending_merge");
  });

  it("returns null when auto-merge is disabled", () => {
    const m = classifyBoardStatusIssueMergeState(
      issue({ diffStats: { filesChanged: 1, insertions: 1, deletions: 0 } as BoardStatusIssue["diffStats"] }),
      { autoMergeEnabled: false, autoMergeInReview: true },
    );
    expect(m).toBeNull();
  });

  it("returns null for a zero-diff workspace", () => {
    const m = classifyBoardStatusIssueMergeState(issue({}), opts);
    expect(m).toBeNull();
  });
});
