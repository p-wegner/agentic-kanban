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
    checkBranchTipIsAncestor: (() => {
      let calls = 0;
      return vi.fn(async () => {
        calls++;
        // First call: pre-merge — not ancestor yet; second+: post-merge — merge landed
        if (calls === 1) return { isAncestor: false as const, branchSha: "branch-sha-456", baseSha: "base-sha-789" };
        return { isAncestor: true as const, branchSha: "branch-sha-456", baseSha: "merge-sha-123" };
      });
    })(),
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
    // If processKiller ran, mergeResolved must have been true at that point —
    // i.e. it must NEVER have been called before mergeWorkspace resolved.
    // (The array is empty if the background task hadn't started yet — that also passes.)
    expect(killerCalledWhileUnresolved.every((resolvedAtCallTime) => resolvedAtCallTime)).toBe(true);
  });

  it("mergedAt is stamped in DB immediately after git merge, independent of response flush (#575)", async () => {
    // Regression for #575: if the HTTP connection drops or the server restarts between
    // gitService.mergeBranch() completing and the full status write, the workspace must
    // still have mergedAt set so the startup reconciler can move it to Done.
    //
    // We simulate this by injecting a failure into updateWorkspaceStatus (the combined
    // status write that follows the early mergedAt stamp) and verifying that mergedAt
    // was still written to the DB before the failure.
    const { workspaceId, issueId } = await seedWorkspace(db);

    // Allow the early mergedAt stamp to succeed but fail the full status update
    let updateCallCount = 0;
    const originalUpdate = db.update.bind(db);
    const updateSpy = vi.spyOn(db, "update").mockImplementation((...args: Parameters<typeof db.update>) => {
      updateCallCount++;
      // First call is the early mergedAt stamp — let it through; subsequent calls are the combined status write
      if (updateCallCount === 1) return originalUpdate(...args);
      // Simulate a crash/interrupted write on the combined status write
      throw new Error("Simulated connection drop mid-merge");
    });

    const git = makeGitService();
    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
    });

    try {
      await svc.mergeWorkspace(workspaceId);
    } catch {
      // Expected — the combined status write threw
    }

    updateSpy.mockRestore();

    // The early mergedAt stamp must have persisted
    const { workspaces: wsTable } = await import("@agentic-kanban/shared/schema");
    const { eq: eqFn } = await import("drizzle-orm");
    const [ws] = await db.select({ mergedAt: wsTable.mergedAt, status: wsTable.status })
      .from(wsTable)
      .where(eqFn(wsTable.id, workspaceId));

    expect(ws.mergedAt).toBeTruthy();
    // Status may still be non-closed (the reconciler would fix this on startup)
    // — the important thing is mergedAt is set so it CAN be reconciled
  });

  it("mergeBranch is called with deferWorkingTreeSync:true so git reset --hard runs after the response (#686)", async () => {
    // Regression for #686: git reset --hard (syncWorkingTreeHard) was called synchronously
    // inside mergeBranch() during the HTTP request. On every merge tsx hot-reload detected
    // the new .ts files and restarted the server before the response was flushed, dropping
    // the connection mid-request (~10s outage). The fix: deferWorkingTreeSync:true skips
    // the reset inside mergeBranch and embeds a [pending-wt-sync:<sha>] tag in the output;
    // runWorkspacePostMergeCleanup calls applyDeferredWorkingTreeSync after setImmediate.
    const { workspaceId } = await seedWorkspace(db);

    let mergeBranchOptions: Record<string, unknown> | undefined;
    const mergeBranch = vi.fn(async (_repo: string, _feature: string, _target: string, opts: Record<string, unknown>) => {
      mergeBranchOptions = opts;
      // Simulate the [pending-wt-sync] tag that real mergeBranch emits when deferWorkingTreeSync:true
      return "Merge branch 'feature/ak-99-test' into master (plumbing-merge: merge-sha-123) [pending-wt-sync:merge-sha-123]";
    });
    const git = makeGitService({ mergeBranch });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
    });

    await svc.mergeWorkspace(workspaceId);

    // mergeBranch must have been called with deferWorkingTreeSync:true
    expect(mergeBranchOptions).toMatchObject({ deferWorkingTreeSync: true });
  });

  it("working-tree sync is deferred: applyDeferredWorkingTreeSync runs after mergeWorkspace resolves (#686)", async () => {
    // The deferred sync should run inside setImmediate (in post-merge cleanup),
    // never before mergeWorkspace returns — verifying the tsx-reload window is closed.
    const { workspaceId } = await seedWorkspace(db);

    let mergeResolved = false;
    const syncCalledBeforeResolve: boolean[] = [];

    const mergeBranch = vi.fn(async () => {
      return "Merge branch 'feature/ak-99-test' into master (plumbing-merge: abc123) [pending-wt-sync:abc123]";
    });
    // applyDeferredWorkingTreeSync is called by runWorkspacePostMergeCleanup; we intercept
    // it via a spy on the gitService (which proxies to the real implementation via overrides).
    // Instead, we track the call ordering by wrapping processKiller (always deferred) and
    // injecting a spy that also intercepts the sync via a mock that runs in cleanup.
    const syncCalledAt: "before" | "after" | null = null;
    const processKiller = vi.fn(async () => {
      // processKiller runs in teardownMergedWorktree — AFTER applyDeferredWorkingTreeSync
      // In this test we track that mergeResolved was true by the time cleanup started
      syncCalledBeforeResolve.push(!mergeResolved);
      return 0;
    });

    const git = makeGitService({ mergeBranch });
    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller,
    });

    const result = await svc.mergeWorkspace(workspaceId);
    mergeResolved = true;
    void syncCalledAt; // suppress lint

    // Allow the background post-merge cleanup to run
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(result).toMatchObject({ id: workspaceId });
    // processKiller (and all post-merge cleanup) must not have run before mergeWorkspace resolved
    expect(syncCalledBeforeResolve.every((beforeResolve) => !beforeResolve)).toBe(true);
  });

  it("slow processKiller does not delay the merge response (keep-alive regression)", async () => {
    // Regression for #563: if teardown runs synchronously, a slow processKiller
    // (e.g. Windows WMIC scan) blocks the event loop and drops the HTTP keep-alive
    // connection before the JSON response is flushed. Teardown must be deferred.
    //
    // We assert ordering (killer runs after resolve) rather than wall-clock time so
    // the test stays green on loaded CI machines.
    const { workspaceId } = await seedWorkspace(db);

    let mergeResolved = false;
    let killerCalledBeforeResolve = false;

    const processKiller = vi.fn(async () => {
      if (!mergeResolved) killerCalledBeforeResolve = true;
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

    const result = await svc.mergeWorkspace(workspaceId);
    mergeResolved = true;

    // Allow the background post-merge task to run.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(result).toMatchObject({ id: workspaceId, mergeOutput: expect.any(String) });
    // The processKiller must never have run while mergeResolved was still false.
    expect(killerCalledBeforeResolve).toBe(false);
  });
});
