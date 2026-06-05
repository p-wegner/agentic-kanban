/**
 * Regression test for the stranded-In-Review bug (#575/#576).
 *
 * Scenario: a readyForMerge workspace is merged (git commit created), but the
 * HTTP response is interrupted before the DB status update completes. Two
 * recovery paths are guarded here:
 *
 *   Path A — mergedAt was stamped before the interruption (fix #575):
 *     reconcileSilentlyMergedWorkspaces finds it and moves the issue to Done.
 *
 *   Path B — server crashed before mergedAt was written (fix #576):
 *     The startup reconciler (reconcileAncestorBranchWorkspaces) finds the
 *     branch tip as an ancestor of base via git and moves the issue to Done.
 */

// startup-tasks.ts imports db/index.js and several services at module level.
// Mock them so we can import reconcileSilentlyMergedWorkspaces without a real DB connection.
vi.mock("../db/index.js", () => ({ db: {}, rawClient: {} }));
vi.mock("../db/manual-migrate.js", () => ({ applyMigrations: vi.fn(async () => {}) }));
vi.mock("../services/project-registration.js", () => ({ deduplicateProjects: vi.fn(async () => {}) }));
vi.mock("../services/agent.service.js", () => ({}));
vi.mock("../services/git.service.js", () => ({
  isMergeInProgress: vi.fn(async () => false),
  abortMerge: vi.fn(async () => {}),
  removeWorktree: vi.fn(async () => {}),
  isRebaseInProgress: vi.fn(async () => false),
  abortRebase: vi.fn(async () => {}),
}));
vi.mock("../db/seed.js", () => ({ ensureBuiltinTags: vi.fn(async () => {}), ensureBuiltinSkills: vi.fn(async () => {}) }));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";
import { reconcileAncestorBranchWorkspaces } from "../startup/ancestor-branch-reconciler.js";
import { reconcileSilentlyMergedWorkspaces } from "../startup/startup-tasks.js";

// ─── shared helpers ──────────────────────────────────────────────────────────

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
    checkBranchTipIsAncestor: vi.fn(async () => ({
      isAncestor: false,
      branchSha: "branch-sha-456",
      baseSha: "base-sha-789",
    })),
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
    issueNumber: 579,
    title: "Merge-interrupted test issue",
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
    branch: "feature/ak-579-test",
    workingDir: "/repo/.worktrees/feature_ak-579-test",
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

// ─── Path A: mergedAt stamped before interruption ────────────────────────────
// The #575 fix ensures mergedAt is written immediately after the git merge
// commit, independent of the combined status-write that follows. When the
// response is dropped between those two writes, mergedAt is set but the issue
// is still In Review. reconcileSilentlyMergedWorkspaces (startup-tasks.ts)
// detects the mergedAt and moves the issue to Done.

describe("interrupted merge — Path A: mergedAt stamped, status write dropped", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("issue ends up Done via mergedAt-based reconciler after interrupted response", async () => {
    const { workspaceId, issueId } = await seedReadyForMergeWorkspace(db);

    // Allow the early mergedAt stamp to succeed; crash the combined status write.
    let updateCallCount = 0;
    const originalUpdate = db.update.bind(db);
    const updateSpy = vi.spyOn(db, "update").mockImplementation((...args: Parameters<typeof db.update>) => {
      updateCallCount++;
      // First db.update = early mergedAt stamp — let it through.
      if (updateCallCount === 1) return originalUpdate(...args);
      // Subsequent updates (combined status write) simulate a dropped connection.
      throw new Error("Simulated response interrupted");
    });

    const git = makeGit();
    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
    });

    try {
      await svc.mergeWorkspace(workspaceId);
    } catch {
      // Expected — the combined status write throws
    }

    updateSpy.mockRestore();

    // The early mergedAt stamp must have survived.
    const [ws] = await db.select({ mergedAt: workspaces.mergedAt, status: workspaces.status })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).toBeTruthy();

    // Issue is still In Review — the status update never landed.
    expect(await getIssueStatusName(db, issueId)).toBe("In Review");

    // Simulate server restart: run the real startup reconciler.
    // It queries for workspaces with mergedAt IS NOT NULL and status != 'closed',
    // then closes them and moves the issue to Done.
    await reconcileSilentlyMergedWorkspaces(db);

    // Issue must now be Done and workspace closed.
    expect(await getIssueStatusName(db, issueId)).toBe("Done");

    const [wsFinal] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(wsFinal.status).toBe("closed");
  });
});

// ─── Path B: server crashed before mergedAt was written ──────────────────────
// The #576 reconciler catches workspaces where the git merge landed (branch tip
// is an ancestor of base) but mergedAt was never written (crash before the first
// DB write). reconcileAncestorBranchWorkspaces detects this via git and closes
// the workspace + moves the issue to Done.

describe("interrupted merge — Path B: server crashed before mergedAt was written", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("issue ends up Done via ancestor-branch reconciler when mergedAt was never written", async () => {
    // Simulate: workspace is In Review, git merge completed, but server crashed
    // before any DB write (mergedAt is null, issue still In Review).
    const { issueId, workspaceId } = await seedReadyForMergeWorkspace(db);

    // Branch tip IS an ancestor of base — git confirms the merge happened.
    const checkAncestor = vi.fn(async (_repo: string, branch: string, base: string) => ({
      isAncestor: true as const,
      branchSha: `sha-${branch}`,
      baseSha: `sha-${base}`,
    }));
    // The workspace has real commits — countCommits must return > 0 to allow reconciliation.
    const countCommits = vi.fn(async () => 1);

    const count = await reconcileAncestorBranchWorkspaces({ database: db, checkAncestor, countCommits });

    expect(count).toBe(1);
    expect(await getIssueStatusName(db, issueId)).toBe("Done");

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBeTruthy();
  });

  it("issue stays In Review when branch is NOT an ancestor (no false positive)", async () => {
    const { issueId } = await seedReadyForMergeWorkspace(db);

    const checkAncestor = vi.fn(async (_repo: string, branch: string, base: string) => ({
      isAncestor: false as const,
      branchSha: `sha-${branch}`,
      baseSha: `sha-${base}`,
    }));

    const count = await reconcileAncestorBranchWorkspaces({ database: db, checkAncestor });

    expect(count).toBe(0);
    expect(await getIssueStatusName(db, issueId)).toBe("In Review");
  });

  it("reconciler is idempotent — running twice after crash recovery doesn't double-close", async () => {
    const { issueId } = await seedReadyForMergeWorkspace(db);

    const checkAncestor = vi.fn(async (_repo: string, branch: string, base: string) => ({
      isAncestor: true as const,
      branchSha: `sha-${branch}`,
      baseSha: `sha-${base}`,
    }));
    const countCommits = vi.fn(async () => 1);

    const firstRun = await reconcileAncestorBranchWorkspaces({ database: db, checkAncestor, countCommits });
    const secondRun = await reconcileAncestorBranchWorkspaces({ database: db, checkAncestor, countCommits });

    expect(firstRun).toBe(1);
    expect(secondRun).toBe(0);
    expect(await getIssueStatusName(db, issueId)).toBe("Done");
  });

  it("workspace branch confirmed ancestor of base after Path B reconciliation", async () => {
    const { workspaceId } = await seedReadyForMergeWorkspace(db);

    const checkAncestor = vi.fn(async (_repo: string, branch: string, base: string) => ({
      isAncestor: true as const,
      branchSha: `sha-${branch}`,
      baseSha: `sha-${base}`,
    }));
    const countCommits = vi.fn(async () => 1);

    await reconcileAncestorBranchWorkspaces({ database: db, checkAncestor, countCommits });

    // Confirm the workspace was reconciled correctly (branch was ancestor, hence closed)
    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt, branch: workspaces.branch, baseBranch: workspaces.baseBranch })
      .from(workspaces).where(eq(workspaces.id, workspaceId));

    expect(ws.status).toBe("closed");
    // The reconciler must have called checkAncestor with the workspace's branch and baseBranch.
    expect(checkAncestor).toHaveBeenCalledWith("/repo", ws.branch, ws.baseBranch, expect.anything());
  });
});
