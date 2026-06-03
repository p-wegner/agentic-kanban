import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";

/**
 * Regression test: POST /workspaces/:id/merge must return its JSON response
 * before post-merge cleanup (worktree removal, branch deletion) runs.
 *
 * Previously, cleanup was synchronous and a stalling removeWorktree/deleteBranch
 * would hold the HTTP connection open until it failed, causing the board monitor
 * to see a 'connection reset' with no response body even though the merge landed.
 */

function makeGitService(overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {}) {
  return {
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    syncBranchToHead: vi.fn(async () => false),
    revParse: vi.fn(async (_repo: string, ref: string) => ref === "HEAD" ? "merge-sha-123" : "branch-sha-456"),
    isAncestor: vi.fn(async () => false),
    mergeBranch: vi.fn(async () => "Merge made by the 'ort' strategy."),
    removeWorktree: vi.fn(overrides.removeWorktree ?? (async () => {})),
    deleteBranch: vi.fn(overrides.deleteBranch ?? (async () => {})),
    getChangedFilesBetween: vi.fn(async () => []),
    getCurrentBranch: vi.fn(async () => "master"),
    autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
    ...overrides,
  };
}

async function seedWorkspace(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
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
  await db.insert(projectStatuses).values({
    id: statusId,
    projectId,
    name: "Done",
    sortOrder: 3,
    isDefault: false,
    createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 99,
    title: "Test merge issue",
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-99-test",
    workingDir: "/repo/.worktrees/feature_ak-99-test",
    baseBranch: "master",
    isDirect: false,
    status: "idle",
    readyForMerge: true,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId, workspaceId };
}

describe("merge endpoint response before cleanup", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("returns a successful response even when removeWorktree throws", async () => {
    const { workspaceId } = await seedWorkspace(db);

    // removeWorktree throws — simulates EBUSY / locked worktree
    const removeWorktree = vi.fn(async () => { throw new Error("EBUSY: resource busy or locked"); });
    const git = makeGitService({ removeWorktree });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
    });

    // Must resolve without throwing — the response is returned before cleanup
    const result = await svc.mergeWorkspace(workspaceId);

    expect(result).toMatchObject({
      id: workspaceId,
      mergeOutput: expect.stringContaining("ort"),
    });
    // No warnings in the synchronous response — cleanup is deferred
    expect((result as { warnings?: unknown }).warnings).toBeUndefined();
  });

  it("returns a successful response even when deleteBranch throws", async () => {
    const { workspaceId } = await seedWorkspace(db);

    const deleteBranch = vi.fn(async () => { throw new Error("fatal: branch not found"); });
    const git = makeGitService({ deleteBranch });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
    });

    const result = await svc.mergeWorkspace(workspaceId);

    expect(result).toMatchObject({
      id: workspaceId,
      mergeOutput: expect.any(String),
    });
    expect((result as { warnings?: unknown }).warnings).toBeUndefined();
  });

  it("returns a successful response even when processKiller throws", async () => {
    const { workspaceId } = await seedWorkspace(db);

    const git = makeGitService();
    const processKiller = vi.fn(async () => { throw new Error("access denied"); });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller,
    });

    const result = await svc.mergeWorkspace(workspaceId);

    expect(result).toMatchObject({
      id: workspaceId,
      mergeOutput: expect.any(String),
    });
    expect((result as { warnings?: unknown }).warnings).toBeUndefined();
  });

  it("cleanup is deferred: removeWorktree is not called before mergeWorkspace resolves", async () => {
    const { workspaceId } = await seedWorkspace(db);

    let mergeResolved = false;
    const removeWorktreeCalled: boolean[] = [];

    const removeWorktree = vi.fn(async () => {
      removeWorktreeCalled.push(mergeResolved);
    });
    const git = makeGitService({ removeWorktree });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
    });

    const mergePromise = svc.mergeWorkspace(workspaceId);
    const result = await mergePromise;
    mergeResolved = true;

    // Give the background task a tick to run
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(result.id).toBe(workspaceId);
    // If removeWorktree was called, it must have been AFTER mergeWorkspace resolved
    if (removeWorktreeCalled.length > 0) {
      expect(removeWorktreeCalled.every((wasResolved) => wasResolved)).toBe(true);
    }
  });
});
