// @covers workspaces.services.teardownOnReconcile
//
// Service-stack teardown on the merge RESOLUTION paths (review finding #13): the
// 'already-merged' retry (reconcileAlreadyMergedRetry) and 'reconcile'
// (reconcileAncestorWorkspace) outcomes end the workspace without ever reaching
// runWorkspacePostMergeCleanup — so they must tear the per-workspace compose stack down
// themselves (using the STORED compose project name from workspaces.service_state), or
// the containers/volumes/host ports leak until the next server restart's reaper.
// Fake git + real test DB; the services engine is spied at its stable exported surface.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";
import { workspaceServicesService } from "../services/workspace-services.service.js";

const SERVICE_STATE = JSON.stringify({ composeProjectName: "ak-ws-teardown-test", status: "up" });

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

async function seedScenario(db: ReturnType<typeof createTestDb>["db"], opts: {
  workspaceStatus?: string;
  mergedAt?: string | null;
  serviceState?: string | null;
  readyForMerge?: boolean;
}) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const doneStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo", defaultBranch: "master",
    createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: statusId, projectId, name: "Todo", sortOrder: 0, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 3, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId, issueNumber: 13, title: "Teardown test issue", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-13-teardown",
    workingDir: "/repo/.worktrees/ws", baseBranch: "master", isDirect: false,
    status: opts.workspaceStatus ?? "idle",
    readyForMerge: opts.readyForMerge ?? false,
    mergedAt: opts.mergedAt ?? null,
    closedAt: opts.mergedAt ? now : null,
    serviceState: opts.serviceState !== undefined ? opts.serviceState : null,
    provider: "claude", createdAt: now, updatedAt: now,
  });

  return { projectId, issueId, workspaceId };
}

describe("merge resolution paths tear down the workspace service stack (#13)", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let teardownSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ({ db } = createTestDb());
    teardownSpy = vi.spyOn(workspaceServicesService, "teardownWorkspaceServices").mockResolvedValue(undefined);
  });

  afterEach(() => {
    teardownSpy.mockRestore();
  });

  it("already-merged retry (mergedAt set) tears the stack down with the STORED compose name", async () => {
    const { workspaceId } = await seedScenario(db, {
      workspaceStatus: "closed",
      mergedAt: new Date().toISOString(),
      serviceState: SERVICE_STATE,
    });
    const svc = createWorkspaceMergeService({
      database: db, gitService: makeGitService() as never, createBackup: async () => {}, processKiller: async () => 0,
    });

    await svc.mergeWorkspace(workspaceId);

    expect(teardownSpy).toHaveBeenCalledWith({
      composeProjectName: "ak-ws-teardown-test",
      composeWorktreePath: "/repo/.worktrees/ws",
    });
  });

  it("ancestor reconcile (branch already landed) tears the stack down", async () => {
    const { workspaceId } = await seedScenario(db, {
      workspaceStatus: "idle",
      readyForMerge: true,
      serviceState: SERVICE_STATE,
    });
    const svc = createWorkspaceMergeService({
      database: db, gitService: makeGitService() as never, createBackup: async () => {}, processKiller: async () => 0,
    });

    const result = await svc.mergeWorkspace(workspaceId) as { reconciled?: boolean };
    expect(result.reconciled).toBe(true);

    expect(teardownSpy).toHaveBeenCalledWith({
      composeProjectName: "ak-ws-teardown-test",
      composeWorktreePath: "/repo/.worktrees/ws",
    });
  });

  it("does not call teardown when no service stack was provisioned (serviceState null)", async () => {
    const { workspaceId } = await seedScenario(db, {
      workspaceStatus: "closed",
      mergedAt: new Date().toISOString(),
      serviceState: null,
    });
    const svc = createWorkspaceMergeService({
      database: db, gitService: makeGitService() as never, createBackup: async () => {}, processKiller: async () => 0,
    });

    await svc.mergeWorkspace(workspaceId);

    expect(teardownSpy).not.toHaveBeenCalled();
  });
});
