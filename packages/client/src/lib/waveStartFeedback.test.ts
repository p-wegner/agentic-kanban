import { describe, expect, it } from "vitest";
import type { DependencyWaveIssue, DependencyWavePlan, DependencyWaveStartResult } from "@agentic-kanban/shared";
import {
  clearWaveIssuesPending,
  describeWaveStartError,
  describeWaveStarting,
  markWaveIssuesPending,
  selectWaveStartCandidates,
  summarizeWaveStart,
} from "./waveStartFeedback.js";

function issue(id: string, startEligible: boolean, issueNumber: number): DependencyWaveIssue {
  return {
    id,
    issueNumber,
    title: `Issue ${issueNumber}`,
    statusName: "Backlog",
    startEligible,
    blockers: [],
    reasons: [],
  };
}

function plan(readyNow: DependencyWaveIssue[], available: number): DependencyWavePlan {
  return {
    projectId: "p1",
    readyNow,
    blocked: [],
    cyclicInvalid: [],
    wip: { current: 0, limit: available, available },
  };
}

function startResult(overrides: Partial<DependencyWaveStartResult> = {}): DependencyWaveStartResult {
  return {
    started: [],
    failed: [],
    skipped: { wipLimit: 5, currentWip: 0, availableSlots: 5, readyButNotStarted: 0 },
    ...overrides,
  };
}

describe("selectWaveStartCandidates", () => {
  it("returns nothing without a plan", () => {
    expect(selectWaveStartCandidates(null)).toEqual([]);
  });

  it("keeps only the start-eligible ready issues", () => {
    const p = plan([issue("a", true, 1), issue("b", false, 2), issue("c", true, 3)], 5);
    expect(selectWaveStartCandidates(p)).toEqual(["a", "c"]);
  });

  it("caps at the open WIP slots, so cards the limit will not start stay unmarked", () => {
    const p = plan([issue("a", true, 1), issue("b", true, 2), issue("c", true, 3)], 2);
    expect(selectWaveStartCandidates(p)).toEqual(["a", "b"]);
  });

  it("marks nothing when the WIP limit leaves no slots", () => {
    const p = plan([issue("a", true, 1)], 0);
    expect(selectWaveStartCandidates(p)).toEqual([]);
  });

  it("treats a negative available count as zero slots", () => {
    const p = plan([issue("a", true, 1)], 0);
    p.wip.available = -3;
    expect(selectWaveStartCandidates(p)).toEqual([]);
  });
});

describe("describeWaveStarting", () => {
  it("names the count and singularizes one issue", () => {
    expect(describeWaveStarting(["a"]).message).toBe(
      "Starting 1 issue — creating the worktree and running setup…",
    );
    expect(describeWaveStarting(["a", "b"]).message).toBe(
      "Starting 2 issues — creating worktrees and running setup…",
    );
  });

  it("carries the attempted ids so the list can badge them", () => {
    const progress = describeWaveStarting(["a", "b"]);
    expect(progress.phase).toBe("starting");
    expect(progress.attemptedIssueIds).toEqual(["a", "b"]);
    expect(progress.failed).toBe(false);
  });
});

describe("summarizeWaveStart", () => {
  it("lists the issue numbers actually started", () => {
    const progress = summarizeWaveStart(
      startResult({ started: [{ issueId: "a", issueNumber: 7, workspaceId: "w1" }] }),
      ["a"],
    );
    expect(progress.message).toBe("Started 1 issue: #7");
    expect(progress.failed).toBe(false);
    expect(progress.phase).toBe("done");
  });

  it("reports a partial start with the first failure's reason", () => {
    const progress = summarizeWaveStart(
      startResult({
        started: [{ issueId: "a", issueNumber: 7, workspaceId: "w1" }],
        failed: [
          { issueId: "b", issueNumber: 8, error: "branch exists" },
          { issueId: "c", issueNumber: 9, error: "no slots" },
        ],
      }),
      ["a", "b", "c"],
    );
    expect(progress.message).toBe("Started 1, 2 failed — #8: branch exists (+1 more)");
    expect(progress.failed).toBe(true);
    expect(progress.attemptedIssueIds).toEqual(["a", "b", "c"]);
  });

  it("says why nothing started when every attempt failed", () => {
    const progress = summarizeWaveStart(
      startResult({ failed: [{ issueId: "b", issueNumber: 8, error: "branch exists" }] }),
      ["b"],
    );
    expect(progress.message).toBe("Nothing started — #8: branch exists");
    expect(progress.failed).toBe(true);
  });

  it("names the WIP numbers rather than a bare 'WIP limit reached'", () => {
    const progress = summarizeWaveStart(
      startResult({ skipped: { wipLimit: 3, currentWip: 3, availableSlots: 0, readyButNotStarted: 2 } }),
      [],
    );
    expect(progress.message).toBe("WIP limit reached (3/3) — nothing started");
    expect(progress.failed).toBe(false);
  });

  it("falls back to the candidates when the server reported no attempts", () => {
    const progress = summarizeWaveStart(startResult(), ["a"]);
    expect(progress.message).toBe("No ready issues to start");
    expect(progress.attemptedIssueIds).toEqual(["a"]);
  });
});

describe("the pending-workspace badge set", () => {
  it("marks this start's issues without disturbing an existing entry", () => {
    const next = markWaveIssuesPending(new Set(["ticket-start"]), ["a", "b"]);
    expect([...next].sort()).toEqual(["a", "b", "ticket-start"]);
  });

  it("does not mutate the previous set", () => {
    const prev = new Set(["x"]);
    markWaveIssuesPending(prev, ["a"]);
    expect([...prev]).toEqual(["x"]);
  });

  it("clears ONLY this start's ids, so a concurrent single-ticket start keeps its badge", () => {
    const marked = markWaveIssuesPending(new Set(["ticket-start"]), ["a", "b"]);
    expect([...clearWaveIssuesPending(marked, ["a", "b"])]).toEqual(["ticket-start"]);
  });

  it("is a no-op when the start had no candidates", () => {
    const prev = new Set(["ticket-start"]);
    expect([...clearWaveIssuesPending(markWaveIssuesPending(prev, []), [])]).toEqual(["ticket-start"]);
  });
});

describe("describeWaveStartError", () => {
  it("surfaces the thrown message as a failed outcome", () => {
    const progress = describeWaveStartError(new Error("500 Internal"), ["a"]);
    expect(progress).toEqual({
      phase: "done",
      attemptedIssueIds: ["a"],
      message: "500 Internal",
      failed: true,
    });
  });

  it("falls back to a generic message for a non-Error throw", () => {
    expect(describeWaveStartError("boom", []).message).toBe("Failed to start wave");
  });
});
