// @covers workspaces.services.reconcileAlreadyMerged.liveSessionGuard
//
// #650: `reconcile-as-done` removes the workspace's worktree. It did so without ever
// looking at whether an agent was still RUNNING in that directory, and one was: a
// fix-and-merge session resolving a conflict had the tree deleted under it mid-command,
// which surfaced from inside as `fatal: not a git repository` in a tree `git status` had
// just reported clean, then an empty directory absent from `git worktree list`.
//
// The fix is not to skip the teardown — the branch really is merged — but to END the
// session first, the way every other terminal path already does. These tests pin both
// halves: the impl calls the stopper BEFORE `removeWorktree`, and the production facade
// actually wires one in (the wiring is where the bug lived; the impl never had a hook).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, workspaces, issues, projectStatuses, sessions } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { reconcileAlreadyMerged } from "../services/workspace-already-merged.service.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";
import { makeTempRepo } from "./helpers/temp-repo.js";

const REPO_PATH = makeTempRepo();

function makeGitService(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getDiff: vi.fn(async () => ""),
    getDiffFromRepo: vi.fn(async () => ""),
    revParse: vi.fn(async () => "sha"),
    checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: true, branchSha: "sha-branch", baseSha: "sha-base" })),
    removeWorktree: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    mergeBranch: vi.fn(async () => "Already up to date."),
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    detectConflictsByBranch: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    syncBranchToHead: vi.fn(async () => false),
    getChangedFilesBetween: vi.fn(async () => []),
    getCurrentBranch: vi.fn(async () => "master"),
    autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
    countUniqueCommits: vi.fn(async () => 1),
    getUncommittedTrackedChanges: vi.fn(async () => []),
    ...overrides,
  };
}

async function seed(db: ReturnType<typeof createTestDb>["db"], opts: { sessionStatus?: string } = {}) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: REPO_PATH, repoName: "repo", defaultBranch: "master",
    createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: statusId, projectId, name: "Todo", sortOrder: 0, createdAt: now },
    { id: randomUUID(), projectId, name: "Done", sortOrder: 3, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId, issueNumber: 650, title: "Live session guard", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-650-guard",
    workingDir: `${REPO_PATH}/.worktrees/ak-650`, baseBranch: "master", isDirect: false,
    status: "idle", readyForMerge: true, provider: "claude", createdAt: now, updatedAt: now,
  });
  if (opts.sessionStatus) {
    await db.insert(sessions).values({
      id: randomUUID(), workspaceId, executor: "claude-code",
      status: opts.sessionStatus, startedAt: now,
    });
  }
  return { projectId, issueId, workspaceId };
}

const noopRecord = async () => {};

describe("reconcile-as-done does not pull the worktree out from under a live agent (#650)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("stops the workspace's sessions BEFORE removing the worktree", async () => {
    const { workspaceId } = await seed(db);
    const order: string[] = [];
    const gitService = makeGitService({ removeWorktree: vi.fn(async () => { order.push("removeWorktree"); }) });
    const stopWorkspaceSessions = vi.fn(async () => { order.push("stopSessions"); });

    await reconcileAlreadyMerged(workspaceId, {
      database: db, gitService: gitService as never, recordMergeAttempt: noopRecord, stopWorkspaceSessions,
    });

    expect(stopWorkspaceSessions).toHaveBeenCalledWith(workspaceId);
    // Order is the whole point: stopping after the removal would still leave the agent
    // standing in a directory that no longer exists.
    expect(order).toEqual(["stopSessions", "removeWorktree"]);
  });

  it("still reconciles when the stopper throws — an unstoppable session must not strand a merged branch", async () => {
    const { workspaceId } = await seed(db);
    const gitService = makeGitService();
    const stopWorkspaceSessions = vi.fn(async () => { throw new Error("session manager is gone"); });

    const result = await reconcileAlreadyMerged(workspaceId, {
      database: db, gitService: gitService as never, recordMergeAttempt: noopRecord, stopWorkspaceSessions,
    });

    expect(result.branch).toBe("feature/ak-650-guard");
    expect(gitService.removeWorktree).toHaveBeenCalled();
  });

  it("works with no stopper injected (the dep is optional)", async () => {
    const { workspaceId } = await seed(db);
    const gitService = makeGitService();

    const result = await reconcileAlreadyMerged(workspaceId, {
      database: db, gitService: gitService as never, recordMergeAttempt: noopRecord,
    });

    expect(result.branch).toBe("feature/ak-650-guard");
    expect(gitService.removeWorktree).toHaveBeenCalled();
  });

  it("the production facade wires a real stopper in — a running session is stopped", async () => {
    const { workspaceId } = await seed(db, { sessionStatus: "running" });
    const stopSession = vi.fn(async () => {});
    const svc = createWorkspaceMergeService({
      database: db,
      gitService: makeGitService() as never,
      createBackup: async () => {},
      processKiller: async () => 0,
      getSessionManager: () => ({ stopSession }) as never,
    });

    await svc.reconcileAlreadyMerged(workspaceId);

    expect(stopSession).toHaveBeenCalledTimes(1);
  });

  it("the facade leaves an already-ended session alone", async () => {
    const { workspaceId } = await seed(db, { sessionStatus: "stopped" });
    const stopSession = vi.fn(async () => {});
    const svc = createWorkspaceMergeService({
      database: db,
      gitService: makeGitService() as never,
      createBackup: async () => {},
      processKiller: async () => 0,
      getSessionManager: () => ({ stopSession }) as never,
    });

    await svc.reconcileAlreadyMerged(workspaceId);

    expect(stopSession).not.toHaveBeenCalled();
  });
});
