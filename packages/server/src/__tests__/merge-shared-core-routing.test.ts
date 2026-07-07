/**
 * #945 — both merge entry paths must route through the ONE shared merge executor core.
 *
 * `doMerge` (workspace-merge.service.ts, used by manual POST /merge, monitor,
 * merge-queue) and `autoMerge` (startup/merge-workflow.ts, used by the review-exit
 * foundational merge and fix-and-merge retry) previously carried two complete,
 * independently-evolved merge implementations. These tests spy on the shared core
 * (`runMergeCore` in services/merge-executor.service.ts) and assert BOTH paths call
 * it — so a merge fix landed in the core lands for every entry path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";

// Swap the module-global db for a fresh in-memory test db so autoMerge (which reads
// preferences/projects through the module-global `db`) hits a throwaway database.
vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const schemaMod = await import("@agentic-kanban/shared/schema");
  const { db } = createTestDb();
  return {
    db,
    writeDb: db,
    rawClient: undefined,
    rawWriteClient: undefined,
    schema: schemaMod,
    withDbRetry: <T>(fn: () => Promise<T>) => fn(),
    withTransaction: <T>(database: { transaction: (fn: unknown) => Promise<T> }, fn: unknown) =>
      database.transaction(fn),
  };
});

// The invariant scanner kicked off after an auto-merge polls the real board — stub it.
vi.mock("../startup/done-unmerged-invariant-scanner.js", () => ({
  runDoneUnmergedScannerNow: vi.fn(),
}));

// Spy on the shared merge executor core. getDirtyMainFiles keeps its benign shape
// (resolveMergeState calls it during doMerge pre-flight).
const { runMergeCore, cleanupMergedWorktreeAndBranch } = vi.hoisted(() => ({
  runMergeCore: vi.fn(),
  cleanupMergedWorktreeAndBranch: vi.fn(),
}));
vi.mock("../services/merge-executor.service.js", () => ({
  runMergeCore,
  cleanupMergedWorktreeAndBranch,
  getDirtyMainFiles: vi.fn(async () => []),
}));

import { db } from "../db/index.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";
import { createAutoMerge } from "../startup/merge-workflow.js";
import { gateSkipExplicit } from "../services/pre-merge-gate.service.js";
import { activeMerges } from "../services/workspace-internals.js";
import type { createBoardEvents } from "../services/board-events.js";
import type { createSessionManager } from "../services/session.manager.js";

async function seedMergeScenario() {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const doneStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId, issueNumber: 945, title: "Unify merge executors", priority: "high",
    sortOrder: 0, statusId: inReviewStatusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-945-test",
    workingDir: null, baseBranch: "master",
    isDirect: false, status: "idle", readyForMerge: true,
    provider: "claude", createdAt: now, updatedAt: now,
  });

  return { projectId, issueId, workspaceId, doneStatusId, inReviewStatusId };
}

beforeEach(() => {
  activeMerges.clear();
  runMergeCore.mockReset();
  runMergeCore.mockResolvedValue({
    mergeOutput: "Merge made by the 'ort' strategy.",
    mergeCommitSha: "merge-commit-sha",
    preMergeHead: "pre-merge-head",
    mergedHeadSha: "feature-tip-sha",
    pendingWorkingTreeSyncSha: null,
  });
  cleanupMergedWorktreeAndBranch.mockReset();
  cleanupMergedWorktreeAndBranch.mockResolvedValue(undefined);
});

describe("#945: both merge entry paths route through the shared merge executor core", () => {
  it("doMerge (manual/monitor/merge-queue path) calls runMergeCore with deferWorkingTreeSync", async () => {
    const { workspaceId, issueId, doneStatusId } = await seedMergeScenario();

    const gitService = {
      autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
      checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: false as const, branchSha: "abc", baseSha: "def" })),
      countUniqueCommits: vi.fn(async () => 1),
      detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
      syncBranchToHead: vi.fn(async () => false),
      getUncommittedTrackedChanges: vi.fn(async () => []),
      getCurrentBranch: vi.fn(async () => "master"),
      getChangedFilesBetween: vi.fn(async () => []),
      removeWorktree: vi.fn(async () => {}),
      deleteBranch: vi.fn(async () => {}),
      revParse: vi.fn(async () => "merge-commit-sha"),
    };

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: gitService as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    const result = await svc.mergeWorkspace(workspaceId);

    expect(result.merged).toBe(true);
    expect(runMergeCore).toHaveBeenCalledTimes(1);
    expect(runMergeCore).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: "/repo",
      branch: "feature/ak-945-test",
      targetBranch: "master",
      deferWorkingTreeSync: true,
    }));

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    expect(issue.statusId).toBe(doneStatusId);
  });

  it("autoMerge (review-exit / fix-and-merge retry path) calls the same runMergeCore", async () => {
    const { projectId, workspaceId, issueId, doneStatusId } = await seedMergeScenario();
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));

    const boardEvents = { broadcast: vi.fn() };
    const sessionManager = { startSession: vi.fn(async () => "sess-1") };

    const autoMerge = createAutoMerge({
      sessionManager: sessionManager as unknown as ReturnType<typeof createSessionManager>,
      boardEvents: boardEvents as unknown as ReturnType<typeof createBoardEvents>,
      learningSessionIds: new Set(),
    });

    await autoMerge(ws, projectId, issueId, doneStatusId, new Date().toISOString(),
      gateSkipExplicit("test: routing check — gate decision is exercised separately"));

    expect(runMergeCore).toHaveBeenCalledTimes(1);
    expect(runMergeCore).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: "/repo",
      branch: "feature/ak-945-test",
      targetBranch: "master",
      deferWorkingTreeSync: false,
    }));
    // autoMerge also routes worktree/branch cleanup through the shared helper.
    expect(cleanupMergedWorktreeAndBranch).toHaveBeenCalledTimes(1);

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    expect(issue.statusId).toBe(doneStatusId);
    expect(boardEvents.broadcast).toHaveBeenCalledWith(projectId, "workspace_merged");
  });
});
