import { describe, it, expect } from "vitest";
import { buildReconcilerPrompt, buildStrandedBatch, pickIntegrationWorkspace } from "../services/reconciler.service.js";
import type { MergeQueuePlan } from "../services/merge-queue.service.js";

const plan: MergeQueuePlan = {
  order: [
    { id: "a", branch: "feature/a", workingDir: "/wt/a", baseBranch: "master", repoPath: "/repo", issueId: "ia", issueNumber: 1, issueTitle: "A", changedFiles: ["x.ts"], status: "idle", isDirect: false },
    { id: "b", branch: "feature/b", workingDir: "/wt/b", baseBranch: "master", repoPath: "/repo", issueId: "ib", issueNumber: 2, issueTitle: "B", changedFiles: ["x.ts", "y.ts"], status: "idle", isDirect: false },
    { id: "c", branch: "feature/c", workingDir: null, baseBranch: "master", repoPath: "/repo", issueId: "ic", issueNumber: 3, issueTitle: "C", changedFiles: ["z.ts"], status: "idle", isDirect: true },
  ],
  overlaps: [
    { workspaceIdA: "a", workspaceIdB: "b", overlapCount: 1, files: ["x.ts"] },
    { workspaceIdA: "a", workspaceIdB: "c", overlapCount: 0, files: [] },
    { workspaceIdA: "b", workspaceIdB: "c", overlapCount: 0, files: [] },
  ],
  totalOverlapScore: 1,
  migrationCollisions: [
    { migrationNumber: "0061", workspaces: [
      { workspaceId: "a", issueNumber: 1, issueTitle: "A", files: ["packages/shared/drizzle/0061_a.sql"] },
      { workspaceId: "b", issueNumber: 2, issueTitle: "B", files: ["packages/shared/drizzle/0061_b.sql"] },
    ] },
  ],
  conflictPreviews: [
    { workspaceId: "a", hasConflicts: true, conflictingFiles: ["x.ts"], isStale: false },
    { workspaceId: "b", hasConflicts: true, conflictingFiles: ["x.ts"], isStale: false },
    { workspaceId: "c", hasConflicts: false, conflictingFiles: [], isStale: false },
  ],
};

describe("buildStrandedBatch", () => {
  it("filters the plan down to the stranded subset", () => {
    const batch = buildStrandedBatch(["a", "b"], plan, { baseBranch: "master", projectId: "p1" });
    expect(batch.order.map((o) => o.workspaceId)).toEqual(["a", "b"]);
    expect(batch.overlaps).toHaveLength(1);
    expect(batch.overlaps[0].files).toEqual(["x.ts"]);
    expect(batch.totalOverlapScore).toBe(1);
    expect(batch.migrationCollisions).toHaveLength(1);
    expect(batch.conflictPreviews.map((c) => c.workspaceId)).toEqual(["a", "b"]);
    expect(batch.projectId).toBe("p1");
    expect(batch.baseBranch).toBe("master");
  });

  it("drops a migration collision that no longer has >1 stranded member", () => {
    const batch = buildStrandedBatch(["a"], plan, { baseBranch: "master", projectId: "p1" });
    expect(batch.migrationCollisions).toHaveLength(0);
    // zero-overlap pairs are excluded too
    expect(batch.overlaps).toHaveLength(0);
    expect(batch.totalOverlapScore).toBe(0);
  });
});

describe("pickIntegrationWorkspace", () => {
  it("picks the least-overlap non-direct member that has a worktree", () => {
    expect(pickIntegrationWorkspace(["a", "b", "c"], plan)?.id).toBe("a");
  });

  it("returns null when every stranded member is direct / has no worktree", () => {
    expect(pickIntegrationWorkspace(["c"], plan)).toBeNull();
  });
});

describe("buildReconcilerPrompt", () => {
  it("substitutes every placeholder from the bundled default (no DB row), $-safe", async () => {
    const prompt = await buildReconcilerPrompt({} as never, {
      baseBranch: "master",
      projectId: "", // empty → skips the DB override lookup, uses the bundled constant
      serverPort: "3007",
      integrationWorkspaceId: "ws-a",
      integrationWorkingDir: "/wt/a",
      strandedBatch: JSON.stringify({ hello: "$world & $1 tokens" }),
    });
    expect(prompt).not.toContain("{{"); // all placeholders resolved
    expect(prompt).toContain("3007");
    expect(prompt).toContain("/wt/a");
    expect(prompt).toContain("ws-a");
    // a `$` in the injected JSON must survive (replacement-function, not String.replace token)
    expect(prompt).toContain('{"hello":"$world & $1 tokens"}');
    expect(prompt).toContain("merge-reconciler"); // playbook body present
  });
});
