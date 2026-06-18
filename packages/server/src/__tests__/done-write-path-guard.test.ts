/**
 * Regression tests for the write-path Done-transition guard (ticket #588).
 *
 * Scenario: an issue whose workspace branch is 1 commit ahead of base (NOT an ancestor)
 * must never be moved to Done status.
 *
 * Root cause of #585/#588: the merge endpoint and auto-merge path lacked a post-merge
 * ancestry check. After mergeBranch() reported success, the issue was immediately set
 * to Done without verifying that the branch tip was now reachable from the target.
 * Additionally, if the project row was missing in auto-merge, the git merge was silently
 * skipped but Done status was still set.
 *
 * Guards added:
 *  1. workspace-merge.service.ts: post-merge checkBranchTipIsAncestor() — throws if
 *     the branch is still not an ancestor of target after mergeBranch() reports success.
 *  2. merge-workflow.ts (auto-merge): same post-merge ancestry check.
 *  3. merge-workflow.ts (auto-merge): "project not found" now throws instead of silently
 *     skipping the merge and proceeding to set Done.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";
import { createAutoMerge } from "../startup/merge-workflow.js";
import { createBoardEvents } from "../services/board-events.js";

// ── shared seed helper ─────────────────────────────────────────────────────

async function seedMergeScenario(db: ReturnType<typeof createTestDb>["db"]) {
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
    issueNumber: 588,
    title: "Regression #588",
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
    branch: "feature/ak-588-test",
    workingDir: "/repo/.worktrees/ws",
    baseBranch: "master",
    isDirect: false,
    status: "idle",
    readyForMerge: true,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId, workspaceId, doneStatusId, inReviewStatusId };
}

// ── Manual merge endpoint (workspace-merge.service.ts) ────────────────────

describe("workspace-merge.service: post-merge ancestry invariant (regression #588)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("blocks Done transition when branch is 1-ahead/not-ancestor after merge (post-merge ancestry check)", async () => {
    const { workspaceId, issueId, inReviewStatusId } = await seedMergeScenario(db);

    // Simulate: mergeBranch appears to succeed but the branch tip remains not an ancestor
    // (replicates the #585 silent-merge-loss scenario).
    const gitService = {
      autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
      // Both pre-merge and post-merge checks return not-ancestor: branch has 1 unique commit
      // ahead and never becomes reachable from base even after the merge call.
      checkBranchTipIsAncestor: vi.fn(async () =>
        ({ isAncestor: false as const, branchSha: "abc123", baseSha: "def456" }),
      ),
      countUniqueCommits: vi.fn(async () => 1),
      detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
      syncBranchToHead: vi.fn(async () => false),
      getUncommittedTrackedChanges: vi.fn(async () => []),
      getCurrentBranch: vi.fn(async () => "master"),
      mergeBranch: vi.fn(async () => "Merged"),
      revParse: vi.fn(async () => "merge-commit-sha"),
      removeWorktree: vi.fn(async () => {}),
      deleteBranch: vi.fn(async () => {}),
      getChangedFilesBetween: vi.fn(async () => []),
    };

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: gitService as never,
      createBackup: async () => {},
    });

    await expect(svc.mergeWorkspace(workspaceId)).rejects.toThrow(/post-merge invariant violated/i);

    // Issue must still be In Review, NOT Done.
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    expect(issue.statusId).toBe(inReviewStatusId);
  });

  it("proceeds to Done when post-merge ancestry check confirms branch is now reachable", async () => {
    const { workspaceId, issueId, doneStatusId } = await seedMergeScenario(db);

    let ancestorCallCount = 0;
    const gitService = {
      autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
      checkBranchTipIsAncestor: vi.fn(async () => {
        ancestorCallCount++;
        if (ancestorCallCount === 1) {
          // Pre-merge: not ancestor yet — triggers actual git merge
          return { isAncestor: false as const, branchSha: "abc123", baseSha: "def456" };
        }
        // Post-merge: branch is now an ancestor — merge landed
        return { isAncestor: true as const, branchSha: "abc123", baseSha: "merge-sha" };
      }),
      countUniqueCommits: vi.fn(async () => 1),
      detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
      syncBranchToHead: vi.fn(async () => false),
      getUncommittedTrackedChanges: vi.fn(async () => []),
      getCurrentBranch: vi.fn(async () => "master"),
      mergeBranch: vi.fn(async () => "Merged feature/ak-588-test into master"),
      revParse: vi.fn(async () => "merge-sha"),
      removeWorktree: vi.fn(async () => {}),
      deleteBranch: vi.fn(async () => {}),
      getChangedFilesBetween: vi.fn(async () => []),
    };

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: gitService as never,
      createBackup: async () => {},
    });

    const result = await svc.mergeWorkspace(workspaceId);

    expect(result.merged).toBe(true);
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    expect(issue.statusId).toBe(doneStatusId);
  });
});

// ── Auto-merge on session exit (createAutoMerge) ──────────────────────────

describe("createAutoMerge: project-not-found guard (regression #588)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("does NOT set Done when project row is missing (no silent skip-to-Done)", async () => {
    const { issueId, workspaceId, doneStatusId, inReviewStatusId } =
      await seedMergeScenario(db);

    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    // Use a projectId that doesn't exist in the DB → project query returns 0 rows.
    const missingProjectId = randomUUID();

    const boardEvents = { broadcast: vi.fn() };
    const sessionManager = { startSession: vi.fn(async () => "sess-1") };

    const autoMerge = createAutoMerge({
      sessionManager: sessionManager as never,
      boardEvents: boardEvents as ReturnType<typeof createBoardEvents>,
      learningSessionIds: new Set(),
    });

    // autoMerge wraps everything in try/catch — the "project not found" throw is caught
    // and triggers the error path, leaving the issue status unchanged.
    //
    // autoMerge reads preferences from the module-global db (not the injected test db); the
    // real board may have learning_step_before_merge=true, whose pre-merge learning poll only
    // runs when workspace.workingDir is set. The worktree is irrelevant to the project-not-found
    // guard (which fires before any worktree work), so pass a worktree-less workspace to avoid
    // a 3-minute poll against a mock session that never completes.
    await autoMerge({ ...ws, workingDir: null }, missingProjectId, issueId, doneStatusId, new Date().toISOString());

    // Issue must NOT be Done — project-not-found guard threw before the git merge ran.
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    expect(issue.statusId).toBe(inReviewStatusId);

    // workflow_error must have fired on the missing projectId
    expect(boardEvents.broadcast).toHaveBeenCalledWith(missingProjectId, "workflow_error");
  });
});
