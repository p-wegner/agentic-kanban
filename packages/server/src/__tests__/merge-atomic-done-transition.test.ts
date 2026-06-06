/**
 * Regression test for #668: merge endpoint strands issue In Review when the
 * HTTP response drops mid-merge.
 *
 * Root cause: finalizeMergeCleanup rolled back the issue → Done transition
 * when the workspace DB update failed, even though the git merge had already
 * landed. The fix removes the rollback — the issue stays Done and the
 * workspace is reconciled later by the startup reconciler.
 *
 * This test simulates a client disconnect / workspace DB failure after the
 * git merge completes and asserts the issue ends up Done.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeGit(overrides: Partial<Record<string, (...a: unknown[]) => unknown>> = {}) {
  return {
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    syncBranchToHead: vi.fn(async () => false),
    revParse: vi.fn(async (_repo: string, ref: string) =>
      ref === "HEAD" ? "merge-commit-sha" : "branch-sha-456",
    ),
    isAncestor: vi.fn(async () => false),
    mergeBranch: vi.fn(async () => "Merge made by the 'ort' strategy."),
    removeWorktree: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    getChangedFilesBetween: vi.fn(async () => []),
    getCurrentBranch: vi.fn(async () => "master"),
    autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
    checkBranchTipIsAncestor: (() => {
      let calls = 0;
      return vi.fn(async () => {
        calls++;
        if (calls === 1) return { isAncestor: false as const, branchSha: "branch-sha-456", baseSha: "base-sha-789" };
        return { isAncestor: true as const, branchSha: "branch-sha-456", baseSha: "merge-commit-sha" };
      });
    })(),
    getUncommittedTrackedChanges: vi.fn(async () => []),
    ...overrides,
  };
}

async function seedReadyForMergeWorkspace(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const doneStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Test",
    repoPath: "/repo",
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 668,
    title: "Merge atomic Done transition test issue",
    priority: "medium",
    sortOrder: 0,
    statusId: inReviewStatusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-668-test",
    workingDir: "/repo/.worktrees/feature_ak-668-test",
    baseBranch: "master",
    isDirect: false,
    status: "idle",
    readyForMerge: true,
    mergedAt: null,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId, workspaceId, inReviewStatusId, doneStatusId };
}

async function getIssueStatusName(
  db: ReturnType<typeof createTestDb>["db"],
  issueId: string,
): Promise<string> {
  const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
  const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
  return status.name;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("#668: atomic Done transition — issue stays Done when workspace DB update fails", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("issue is Done even when workspace close DB write fails after git merge", async () => {
    const { workspaceId, issueId } = await seedReadyForMergeWorkspace(db);

    // Simulate: workspace update (the second write in finalizeMergeCleanup) fails.
    // This models a DB timeout / lock / crash that coincides with the HTTP response
    // being written — the client sees a dropped connection.
    let updateCallCount = 0;
    const originalUpdate = db.update.bind(db);
    const updateSpy = vi.spyOn(db, "update").mockImplementation((...args: Parameters<typeof db.update>) => {
      updateCallCount++;
      // 1st update: early mergedAt stamp — let through
      // 2nd update: issue → Done — let through
      // 3rd update: workspace → closed — simulate failure (DB timeout / crash)
      if (updateCallCount <= 2) return originalUpdate(...args);
      throw new Error("Simulated DB timeout writing workspace close");
    });

    const git = makeGit();
    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
    });

    // #668 fix: mergeWorkspace should NOT throw when the workspace close fails
    // after issue was transitioned to Done. The response still returns successfully.
    const result = await svc.mergeWorkspace(workspaceId);

    updateSpy.mockRestore();

    // Response is returned successfully (merge did land)
    expect(result).toMatchObject({
      id: workspaceId,
      mergeOutput: expect.stringContaining("ort"),
    });

    // Issue MUST be Done — not rolled back to In Review
    expect(await getIssueStatusName(db, issueId)).toBe("Done");

    // mergedAt was stamped early — even if workspace close failed, reconciler can clean up
    const [ws] = await db.select({ mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).toBeTruthy();
  });

  it("issue is Done when workspace close fails AND connection drops (response not received)", async () => {
    // Simulates a full client disconnect: the merge service completes internally
    // (issue Done, mergedAt stamped) but the HTTP client never sees the response.
    // The key assertion: DB state is correct regardless of HTTP delivery.
    const { workspaceId, issueId } = await seedReadyForMergeWorkspace(db);

    let updateCallCount = 0;
    const originalUpdate = db.update.bind(db);
    const updateSpy = vi.spyOn(db, "update").mockImplementation((...args: Parameters<typeof db.update>) => {
      updateCallCount++;
      // Let the first 2 writes succeed (mergedAt stamp + issue Done).
      // The 3rd write (workspace close) simulates a DB timeout that coincides
      // with the HTTP socket being destroyed.
      if (updateCallCount <= 2) return originalUpdate(...args);
      throw new Error("Simulated connection drop mid-response");
    });

    const git = makeGit();
    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
    });

    const result = await svc.mergeWorkspace(workspaceId);
    updateSpy.mockRestore();

    // Merge succeeded at the git + issue level
    expect(result.merged).toBe(true);

    // Issue is Done (the fix: no rollback)
    expect(await getIssueStatusName(db, issueId)).toBe("Done");

    // Branch is confirmed as ancestor of base (git merge verified)
    expect(git.checkBranchTipIsAncestor).toHaveBeenCalledTimes(2); // pre-merge + post-merge
  });

  it("mergeWorkspace resolves successfully even if all DB writes after git merge fail", async () => {
    // Edge case: the early mergedAt stamp itself fails (non-fatal in production).
    // With the #668 fix, the merge should still succeed and issue should end up Done
    // because finalizeMergeCleanup does its own mergedAt write.
    const { workspaceId, issueId } = await seedReadyForMergeWorkspace(db);

    let updateCallCount = 0;
    const originalUpdate = db.update.bind(db);
    const updateSpy = vi.spyOn(db, "update").mockImplementation((...args: Parameters<typeof db.update>) => {
      updateCallCount++;
      // 1st: early mergedAt stamp — let fail (non-fatal path in stampMergedAtEarly)
      // 2nd: issue → Done — let through
      // 3rd: workspace → closed — let fail
      if (updateCallCount === 2) return originalUpdate(...args);
      throw new Error("Simulated DB failure");
    });

    const git = makeGit();
    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
    });

    const result = await svc.mergeWorkspace(workspaceId);
    updateSpy.mockRestore();

    expect(result.merged).toBe(true);
    // Issue is Done — the critical transition succeeded
    expect(await getIssueStatusName(db, issueId)).toBe("Done");
  });

  it("normal merge: both workspace closed and issue Done on clean path", async () => {
    // Sanity check: the fix doesn't break the happy path
    const { workspaceId, issueId } = await seedReadyForMergeWorkspace(db);

    const git = makeGit();
    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
    });

    const result = await svc.mergeWorkspace(workspaceId);

    expect(result).toMatchObject({
      id: workspaceId,
      merged: true,
      mergeOutput: expect.any(String),
    });
    expect(await getIssueStatusName(db, issueId)).toBe("Done");

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBeTruthy();
  });
});
