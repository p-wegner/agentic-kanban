import { describe, expect, it } from "vitest";
import {
  describeReleasePartition,
  partitionMergeRelease,
  releaseBatches,
  trainMemberIneligibility,
} from "../services/merge-release-partition.js";
import { trainEligible } from "../services/merge-queue-train.js";
import type { WorkspaceQueueInfo } from "../services/merge-queue.service.js";

/**
 * #1180 — the pure half of the fix for "train window closed … releasing 13" followed by 13
 * sequential merges and no `merge_trains` row. The orchestrator's release is the UNION of every
 * project window that closed on one tick, so it can span repos; `trainEligible` judged that
 * union as a whole, so one foreign or branch-less member sank the train for everybody.
 */
function member(id: string, overrides: Partial<WorkspaceQueueInfo> = {}): WorkspaceQueueInfo {
  return {
    id,
    branch: `feature/${id}`,
    workingDir: `/repo-a/.worktrees/${id}`,
    baseBranch: "main",
    repoPath: "/repo-a",
    issueId: `issue-${id}`,
    issueNumber: Number.parseInt(id.replace(/\D/g, ""), 10) || null,
    issueTitle: `Issue ${id}`,
    changedFiles: [],
    status: "idle",
    isDirect: false,
    ...overrides,
  };
}

describe("partitionMergeRelease (#1180)", () => {
  it("splits a release that spans repos into one candidate train per (repoPath, baseBranch)", () => {
    const order = [
      member("ws1"),
      member("ws2", { repoPath: "/repo-b", workingDir: "/repo-b/.worktrees/ws2" }),
      member("ws3"),
      member("ws4", { repoPath: "/repo-b", workingDir: "/repo-b/.worktrees/ws4" }),
    ];
    // The union is what the orchestrator used to hand the queue — and it is NOT train-eligible.
    expect(trainEligible(order)).toBe(false);

    const partition = partitionMergeRelease(order);
    expect(partition.trains).toEqual([
      { repoPath: "/repo-a", baseBranch: "main", workspaceIds: ["ws1", "ws3"] },
      { repoPath: "/repo-b", baseBranch: "main", workspaceIds: ["ws2", "ws4"] },
    ]);
    expect(partition.singles).toEqual([]);
    expect(partition.ineligible).toEqual([]);

    // Each partition on its own satisfies `trainEligible` unchanged — that is the whole point.
    for (const train of partition.trains) {
      expect(trainEligible(order.filter((ws) => train.workspaceIds.includes(ws.id)))).toBe(true);
    }
  });

  it("a different base branch in the same repo is its own partition", () => {
    const order = [member("ws1"), member("ws2", { baseBranch: "release/1.x" }), member("ws3")];
    const partition = partitionMergeRelease(order);
    expect(partition.trains).toEqual([{ repoPath: "/repo-a", baseBranch: "main", workspaceIds: ["ws1", "ws3"] }]);
    expect(partition.singles).toEqual([{ repoPath: "/repo-a", baseBranch: "release/1.x", workspaceIds: ["ws2"] }]);
  });

  it("peels a branch-less member off into the sequential path without sinking the train for the rest", () => {
    const order = [member("ws1"), member("ws2", { branch: "" }), member("ws3")];
    expect(trainEligible(order)).toBe(false);

    const partition = partitionMergeRelease(order);
    expect(partition.trains).toEqual([{ repoPath: "/repo-a", baseBranch: "main", workspaceIds: ["ws1", "ws3"] }]);
    expect(partition.ineligible).toEqual([{ workspaceId: "ws2", issueNumber: 2, reason: "no branch" }]);

    expect(releaseBatches(partition)).toEqual([
      { workspaceIds: ["ws1", "ws3"], strategy: "train" },
      { workspaceIds: ["ws2"], strategy: "sequential" },
    ]);
  });

  it("classifies every way a member can never ride, in the order trainEligible checked them", () => {
    expect(trainMemberIneligibility(member("ws1", { isDirect: true, branch: "" }))).toBe("direct workspace");
    expect(trainMemberIneligibility(member("ws1", { branch: "" }))).toBe("no branch");
    expect(trainMemberIneligibility(member("ws1", { workingDir: null }))).toBe("no workingDir");
    expect(trainMemberIneligibility(member("ws1"))).toBeNull();
  });

  it("leaves a single-repo eligible batch as exactly one train, with nothing to explain", () => {
    const order = [member("ws1"), member("ws2"), member("ws3")];
    const partition = partitionMergeRelease(order);
    expect(partition).toEqual({
      trains: [{ repoPath: "/repo-a", baseBranch: "main", workspaceIds: ["ws1", "ws2", "ws3"] }],
      singles: [],
      ineligible: [],
    });
    expect(releaseBatches(partition)).toEqual([{ workspaceIds: ["ws1", "ws2", "ws3"], strategy: "train" }]);
    expect(describeReleasePartition(partition, 3)).toBeNull();
  });

  it("a lone released workspace rides sequentially and is not worth a log line", () => {
    const partition = partitionMergeRelease([member("ws1")]);
    expect(releaseBatches(partition)).toEqual([{ workspaceIds: ["ws1"], strategy: "sequential" }]);
    expect(describeReleasePartition(partition, 1)).toBeNull();
  });
});

describe("describeReleasePartition — the one line naming why a release was not a single train", () => {
  it("names the trains it split into and the members that ride sequentially, with the first reason", () => {
    const order = [
      member("ws1"),
      member("ws2", { repoPath: "/repo-b", workingDir: "/repo-b/.worktrees/ws2" }),
      member("ws3"),
      member("ws4", { repoPath: "/repo-b", workingDir: "/repo-b/.worktrees/ws4" }),
      member("ws5", { branch: "" }),
      member("ws6", { isDirect: true, branch: "" }),
      member("ws7", { repoPath: "/repo-c", workingDir: "/repo-c/.worktrees/ws7" }),
    ];
    const line = describeReleasePartition(partitionMergeRelease(order), order.length);
    expect(line).toBe(
      "release of 7 workspace(s) is not one train: 2 train(s) [/repo-a@main ×2, /repo-b@main ×2]; " +
        "3 ride sequentially: 2 member(s) ineligible (first: ws ws5 #5 — no branch), 1 alone in its repo/base",
    );
  });

  it("says 'no train' when nothing can ride at all", () => {
    const order = [member("ws1", { branch: "" }), member("ws2", { workingDir: null })];
    expect(describeReleasePartition(partitionMergeRelease(order), 2)).toBe(
      "release of 2 workspace(s) is not one train: no train; 2 ride sequentially: 2 member(s) ineligible (first: ws ws1 #1 — no branch)",
    );
  });
});
