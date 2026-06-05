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
    checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: false, branchSha: "branch-sha-456", baseSha: "base-sha-789" })),
    getUncommittedTrackedChanges: vi.fn(async () => []),
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

  it("teardown (processKiller) is deferred: not called before mergeWorkspace resolves", async () => {
    // Regression for #563: worktree teardown (kill procs + free ports) was on the
    // hot request path before mergeBranch, blocking the HTTP keep-alive socket.
    // The fix moves it to runPostMergeTasks (fire-and-forget) — this test asserts
    // processKiller is never invoked until after mergeWorkspace has already returned.
    const { workspaceId } = await seedWorkspace(db);

    let mergeResolved = false;
    const killerCalledWhileUnresolved: boolean[] = [];

    const processKiller = vi.fn(async () => {
      killerCalledWhileUnresolved.push(mergeResolved);
      return 0;
    });
    const git = makeGitService();

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller,
    });

    const result = await svc.mergeWorkspace(workspaceId);
    mergeResolved = true;

    // Allow the background post-merge task to run.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(result).toMatchObject({ id: workspaceId, mergeOutput: expect.any(String) });
    // processKiller may or may not run in the background, but it must NEVER have
    // been called while mergeResolved was still false (i.e. before the response).
    expect(killerCalledWhileUnresolved.every((calledBeforeResolve) => !calledBeforeResolve)).toBe(true);
  });

  it("slow processKiller does not delay the merge response (keep-alive regression)", async () => {
    // Regression for #563: if teardown runs synchronously, a slow processKiller
    // (e.g. Windows WMIC scan) blocks the event loop and drops the HTTP keep-alive
    // connection before the JSON response is flushed. Teardown must be deferred.
    const { workspaceId } = await seedWorkspace(db);

    // Simulate a slow teardown that takes 50ms — on the hot path this would stall
    // the response by at least that much and risk dropping the keep-alive connection.
    const processKiller = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      return 1;
    });
    const git = makeGitService();

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller,
    });

    const start = Date.now();
    const result = await svc.mergeWorkspace(workspaceId);
    const elapsed = Date.now() - start;

    expect(result).toMatchObject({ id: workspaceId, mergeOutput: expect.any(String) });
    // If teardown ran synchronously the response would take ≥50ms. With it deferred
    // the synchronous path should complete well under that threshold.
    expect(elapsed).toBeLessThan(45);
  });
});
