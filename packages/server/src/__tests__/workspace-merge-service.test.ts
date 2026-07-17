/**
 * Unit tests for the extracted WorkspaceMergeService.
 * Covers the three acceptance-criteria paths from ticket #548:
 *   1. Clean merge: advances the base branch, workspace closes, issue moves to Done.
 *   2. Already-merged (tip is ancestor): reconciles as no-op instead of throwing 409.
 *   3. Idempotency on retry: mergedAt workspace reconciles as already-merged.
 *
 * Also covers the state machine paths from ticket #610:
 *   4. conflict-ready: conflict detected → throws CONFLICT, clears readyForMerge.
 *   5. conflict-ready (behind): rebase fails → conflict-ready with behindCount.
 *   6. error-skip: dirty-main → throws CONFLICT without git merge.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";
import { insertWorkspaceRepo } from "../repositories/repo.repository.js";
import { resolveMergeState, WorkspaceError, activeMerges } from "../services/workspace-internals.js";
import { createMockSessionManager } from "./helpers/mocks.js";

// Test isolation: the per-repoPath merge lock (activeMerges) is a module-level Map.
// If one test is killed by vitest's timeout while its mergePromise is still pending
// (e.g. under heavy parallel CPU load in the full suite), its .finally() release has
// not run yet, so the lock leaks and every following test that merges the same '/repo'
// fails with "A merge is already in progress" — turning one slow test into a cascade
// of false failures. Clearing the map before each test confines a timeout to itself.
beforeEach(() => {
  activeMerges.clear();
});

function makeGit(overrides: Partial<Record<string, (...a: unknown[]) => unknown>> = {}) {
  return {
    getDiff: vi.fn(async () => ""),
    getDiffFromRepo: vi.fn(async () => ""),
    revParse: vi.fn(async (_repo: string, ref: string) => {
      if (ref === "feature/ak-548-test") return "feature-sha";
      if (ref === "master") return "master-sha-before";
      return "merge-commit-sha";
    }),
    isAncestor: vi.fn(async () => false),
    mergeBranch: vi.fn(async () => "Merge made by the 'ort' strategy."),
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    syncBranchToHead: vi.fn(async () => false),
    removeWorktree: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    getChangedFilesBetween: vi.fn(async () => []),
    getCurrentBranch: vi.fn(async () => "master"),
    autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
    checkBranchTipIsAncestor: (() => {
      let calls = 0;
      return vi.fn(async () => {
        calls++;
        // First call: pre-merge check — branch not yet ancestor
        // Second+ call: post-merge check — branch is now ancestor (merge landed)
        if (calls === 1) return { isAncestor: false as const, branchSha: "feature-sha", baseSha: "master-sha-before" };
        return { isAncestor: true as const, branchSha: "feature-sha", baseSha: "merge-commit-sha" };
      });
    })(),
    getUncommittedTrackedChanges: vi.fn(async () => []),
    countUniqueCommits: vi.fn(async () => 1),
    rebaseOntoBase: vi.fn(async () => ({ success: true })),
    mergeBaseIntoBranch: vi.fn(async () => ({ success: true })),
    ...overrides,
  };
}

async function seedWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  opts: { readyForMerge?: boolean; mergedAt?: string; status?: string; baseCommitSha?: string | null } = {},
) {
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
    issueNumber: 548,
    title: "Test issue",
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
    branch: "feature/ak-548-test",
    workingDir: "/repo/.worktrees/feature_ak-548-test",
    baseBranch: "master",
    isDirect: false,
    status: opts.status ?? (opts.mergedAt ? "closed" : "idle"),
    readyForMerge: opts.readyForMerge ?? true,
    mergedAt: opts.mergedAt ?? null,
    baseCommitSha: opts.baseCommitSha ?? null,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId, workspaceId, doneStatusId };
}

async function insertSession(
  db: ReturnType<typeof createTestDb>["db"],
  payload: {
    workspaceId: string;
    status: "stopped" | "running" | "completed";
    startedAt?: string;
    endedAt?: string | null;
    triggerType?: string;
    stats?: string;
  },
): Promise<string> {
  const id = randomUUID();
  await db.insert(sessions).values({
    id,
    workspaceId: payload.workspaceId,
    executor: "claude-code",
    status: payload.status,
    startedAt: payload.startedAt ?? new Date().toISOString(),
    endedAt: payload.endedAt ?? null,
    triggerType: payload.triggerType ?? "fix-and-merge",
    stats: payload.stats,
  });
  return id;
}

// ─── Path 1: clean merge ────────────────────────────────────────────────────

describe("MergeService — clean merge advances base", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("calls mergeBranch and returns merged=true with SHAs", async () => {
    const { workspaceId } = await seedWorkspace(db);
    let headCallCount = 0;
    const git = makeGit({
      revParse: async (_repo: string, ref: string) => {
        if (ref === "feature/ak-548-test") return "feature-sha";
        if (ref === "master") return "master-sha-before";
        headCallCount++;
        return headCallCount === 1 ? "master-sha-before" : "merge-commit-sha";
      },
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    const result = await svc.mergeWorkspace(workspaceId);

    expect(git.mergeBranch).toHaveBeenCalledWith("/repo", "feature/ak-548-test", "master", { deferWorkingTreeSync: true, autoResolveAppendConflicts: true });
    expect(result.merged).toBe(true);
    expect(result.baseBranch).toBe("master");
    expect(result.mergeOutput).toContain("ort");
    expect(result.baseHeadShaBefore).toBeDefined();
    expect(result.baseHeadShaAfter).toBeDefined();
  });

  it("closes the workspace and moves the issue to Done after a clean merge", async () => {
    const { workspaceId, issueId } = await seedWorkspace(db);
    const git = makeGit();

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    await svc.mergeWorkspace(workspaceId);

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBeTruthy();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });
});

// ─── Path 2: already-merged (tip is ancestor) ───────────────────────────────

describe("MergeService — already-merged tip reconciles as no-op", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("returns reconciled=true and does NOT call mergeBranch", async () => {
    const { workspaceId } = await seedWorkspace(db);
    const mergeBranch = vi.fn(async () => "Merge made by the 'ort' strategy.");
    const git = makeGit({
      revParse: async (_repo: string, ref: string) => ref === "feature/ak-548-test" ? "ancestor-sha" : "master-sha",
      isAncestor: async () => true,
      checkBranchTipIsAncestor: async () => ({ isAncestor: true, branchSha: "ancestor-sha", baseSha: "master-sha" }),
      mergeBranch,
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    const result = await svc.mergeWorkspace(workspaceId);

    expect(mergeBranch).not.toHaveBeenCalled();
    expect(result.merged).toBe(false);
    expect(result.reconciled).toBe(true);
    expect(result.mergeOutput).toMatch(/already fully merged|no-op/i);
  });

  it("moves the issue to Done even on no-op reconcile", async () => {
    const { workspaceId, issueId } = await seedWorkspace(db);
    const git = makeGit({
      revParse: async (_repo: string, ref: string) => ref === "feature/ak-548-test" ? "ancestor-sha" : "master-sha",
      isAncestor: async () => true,
      checkBranchTipIsAncestor: async () => ({ isAncestor: true, branchSha: "ancestor-sha", baseSha: "master-sha" }),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    await svc.mergeWorkspace(workspaceId);

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });
});

// ─── Path 3: dropped-response idempotency on retry ──────────────────────────

describe("MergeService — idempotency: retry after dropped response", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("reconciles idempotently when mergedAt is set (dropped-response retry)", async () => {
    const now = new Date().toISOString();
    const { workspaceId, issueId } = await seedWorkspace(db, {
      mergedAt: now,
      status: "closed",
      readyForMerge: false,
    });
    // Genuinely merged → branch is an ancestor (#820 guard verifies before honoring mergedAt).
    const git = makeGit({ checkBranchTipIsAncestor: async () => ({ isAncestor: true, branchSha: "feature-sha", baseSha: "master-sha" }) });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).resolves.toMatchObject({
      mergeOutput: expect.stringContaining("already marked as merged"),
    });

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBe(now);
  });

  it("does not call mergeBranch on a dropped-response retry", async () => {
    const now = new Date().toISOString();
    const { workspaceId } = await seedWorkspace(db, {
      mergedAt: now,
      status: "closed",
      readyForMerge: false,
    });
    const mergeBranch = vi.fn(async () => "Merge made by the 'ort' strategy.");
    // Genuinely merged → branch is an ancestor (#820 guard verifies before honoring mergedAt).
    const git = makeGit({ mergeBranch, checkBranchTipIsAncestor: async () => ({ isAncestor: true, branchSha: "feature-sha", baseSha: "master-sha" }) });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).resolves.toBeDefined();
    expect(mergeBranch).not.toHaveBeenCalled();
  });

  it("reconciles when a retry sees the landed branch as an ancestor with no current-base unique commits", async () => {
    const { workspaceId, issueId } = await seedWorkspace(db, {
      status: "idle",
      readyForMerge: true,
      baseCommitSha: "base-sha",
    });
    const mergeBranch = vi.fn(async () => "Merge made by the 'ort' strategy.");
    const git = makeGit({
      checkBranchTipIsAncestor: vi.fn(async () => ({
        isAncestor: true as const,
        branchSha: "feature-sha",
        baseSha: "merge-commit-sha",
      })),
      countUniqueCommits: vi.fn(async (_repo: string, baseSha: string) => baseSha === "base-sha" ? 1 : 0),
      mergeBranch,
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    const result = await svc.mergeWorkspace(workspaceId);

    expect(mergeBranch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ merged: false, reconciled: true });
    expect(result.mergeOutput).toMatch(/already fully merged|no-op/i);

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBeTruthy();
  });
});

// ─── Path 4a: updateBase rebase uses local base, not origin (#601) ──────────

describe("MergeService — updateBase rebase uses preferLocalBase", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("passes preferLocalBase:true to rebaseOntoBase so it rebases onto local master, not origin", async () => {
    const { workspaceId } = await seedWorkspace(db, { status: "idle" });
    const rebaseOntoBase = vi.fn(async () => ({ success: true }));
    const git = makeGit({ rebaseOntoBase });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    await svc.updateBase(workspaceId, "rebase");

    expect(rebaseOntoBase).toHaveBeenCalledWith(
      "/repo/.worktrees/feature_ak-548-test",
      "master",
      "feature/ak-548-test",
      { preferLocalBase: true },
    );
  });

  it("rebases the leading worktree AND every sibling worktree onto its own base (#72)", async () => {
    const { workspaceId, projectId } = await seedWorkspace(db, { status: "idle" });
    await insertWorkspaceRepo(
      { workspaceId, projectId, path: "/extra", name: "extra", worktreePath: "/extra/.worktrees/ws", branch: "feature/ak-548-test", baseBranch: "main" },
      db,
    );
    const rebaseOntoBase = vi.fn(async () => ({ success: true }));
    const git = makeGit({ rebaseOntoBase });

    const svc = createWorkspaceMergeService({ database: db, gitService: git as never, createBackup: async () => {}, processKiller: async () => 0 });
    const result = await svc.updateBase(workspaceId, "rebase");

    expect(result.success).toBe(true);
    expect(rebaseOntoBase).toHaveBeenCalledWith("/repo/.worktrees/feature_ak-548-test", "master", "feature/ak-548-test", { preferLocalBase: true });
    expect(rebaseOntoBase).toHaveBeenCalledWith("/extra/.worktrees/ws", "main", "feature/ak-548-test", { preferLocalBase: true });
  });

  it("surfaces a sibling rebase conflict namespaced by repo and fails overall (#72)", async () => {
    const { workspaceId, projectId } = await seedWorkspace(db, { status: "idle" });
    await insertWorkspaceRepo(
      { workspaceId, projectId, path: "/extra", name: "extra", worktreePath: "/extra/.worktrees/ws", branch: "feature/ak-548-test", baseBranch: "main" },
      db,
    );
    const rebaseOntoBase = vi.fn(async (worktree: unknown) =>
      String(worktree).startsWith("/extra") ? { success: false, conflictingFiles: ["src/server.js"] } : { success: true },
    );
    const git = makeGit({ rebaseOntoBase });

    const svc = createWorkspaceMergeService({ database: db, gitService: git as never, createBackup: async () => {}, processKiller: async () => 0 });
    const result = await svc.updateBase(workspaceId, "rebase");

    expect(result.success).toBe(false);
    expect(result.conflictingFiles).toContain("extra::src/server.js");
  });

  it("does NOT pass preferLocalBase when using merge mode (different code path)", async () => {
    const { workspaceId } = await seedWorkspace(db, { status: "idle" });
    const mergeBaseIntoBranch = vi.fn(async () => ({ success: true }));
    const git = makeGit({ mergeBaseIntoBranch });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    await svc.updateBase(workspaceId, "merge");

    expect(mergeBaseIntoBranch).toHaveBeenCalledWith(
      "/repo/.worktrees/feature_ak-548-test",
      "master",
    );
  });
});

// ─── Path 4: merge from fixing status (regression #551) ─────────────────────

describe("MergeService — merge from fixing status moves issue to Done", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("closes the workspace and moves the issue to Done when merging from fixing status", async () => {
    // Workspace in "fixing" (fix-and-merge session running) with readyForMerge=true
    // — the board monitor or HTTP client calls merge while the agent is still running.
    const { workspaceId, issueId } = await seedWorkspace(db, { status: "fixing", readyForMerge: true });
    const git = makeGit();

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    await svc.mergeWorkspace(workspaceId);

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBeTruthy();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });

  it("force-stops a stale zero-output fix-and-merge session before retrying merge", async () => {
    const { workspaceId } = await seedWorkspace(db, { status: "fixing", readyForMerge: true });
    const sessionId = await insertSession(db, {
      workspaceId,
      status: "running",
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      triggerType: "fix-and-merge",
    });

    const calls: string[] = [];
    const git = makeGit({
      mergeBranch: vi.fn(async () => {
        calls.push("merge");
        return "Merge made by the 'ort' strategy.";
      }),
    });
    const sessionManager = createMockSessionManager();
    (sessionManager.stopSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push("stop");
      return true;
    });

    const svc = createWorkspaceMergeService({
      database: db,
      getSessionManager: () => sessionManager,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await svc.mergeWorkspace(workspaceId);

    expect(sessionManager.stopSession).toHaveBeenCalledWith(sessionId);
    expect(calls).toEqual(["stop", "merge"]);

    const [session] = await db
      .select({ status: sessions.status, endedAt: sessions.endedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session.status).toBe("stopped");
    expect(session.endedAt).toBeTruthy();
  });
});

// ─── resolveMergeState unit tests (#610) ─────────────────────────────────────

function makeWorkspace(overrides: Partial<typeof workspaces.$inferSelect> = {}): typeof workspaces.$inferSelect {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    issueId: randomUUID(),
    branch: "feature/ak-548-test",
    workingDir: "/repo/.worktrees/feature_ak-548-test",
    baseBranch: "master",
    isDirect: false,
    status: "idle",
    readyForMerge: true,
    mergedAt: null,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    claudeProfile: null,
    baseCommitSha: null,
    requiresReview: false,
    thoroughReview: false,
    planMode: false,
    tddMode: false,
    includeVisualProof: false,
    skillId: null,
    cleanupWarning: null,
    agentCommand: null,
    model: null,
    pendingPlanPath: null,
    currentNodeId: null,
    parentWorkspaceId: null,
    forkNodeId: null,
    forkJoinNodeId: null,
    forkStatus: null,
    showdownId: null,
    showdownLabel: null,
    conflictCacheCheckedAt: null,
    conflictCacheHasConflicts: null,
    conflictCacheFiles: null,
    diffStatCacheCheckedAt: null,
    diffStatCacheHeadSha: null,
    diffStatCacheFilesChanged: null,
    diffStatCacheInsertions: null,
    diffStatCacheDeletions: null,
    scorecardScore: null,
    scorecardJson: null,
    scorecardComputedAt: null,
    codeMetricsJson: null,
    codeMetricsComputedAt: null,
    latestSetupCommand: null,
    latestSetupState: null,
    latestSetupStartedAt: null,
    latestSetupEndedAt: null,
    latestSetupExitCode: null,
    latestSetupDurationMs: null,
    latestSetupStdoutTail: null,
    latestSetupStderrTail: null,
    latestSymlinkState: null,
    latestSymlinkStartedAt: null,
    latestSymlinkEndedAt: null,
    latestSymlinkDirs: null,
    latestSymlinkLinked: null,
    latestSymlinkSkipped: null,
    latestSymlinkFailed: null,
    latestSymlinkError: null,
    contextPrimer: null,
    ...overrides,
  };
}

function makeGitForStateMachine(overrides: Partial<Record<string, (...a: unknown[]) => unknown>> = {}) {
  return {
    checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: false, branchSha: "sha-branch", baseSha: "sha-base" })),
    countUniqueCommits: vi.fn(async () => 1),
    getUncommittedTrackedChanges: vi.fn(async () => [] as string[]),
    countBehindCommits: vi.fn(async () => 0),
    rebaseOntoBase: vi.fn(async () => ({ success: true })),
    abortRebase: vi.fn(async () => {}),
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] as string[] })),
    detectConflictsByBranch: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] as string[] })),
    ...overrides,
  };
}


describe("MergeService — retryable sessions recover from stale failed fix-and-merge state", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("recoverFailedFixAndMergeSessionIfNeeded: resolves resolveConflicts from zero-output fixing zombie", async () => {
    const { workspaceId } = await seedWorkspace(db, { status: "fixing" });
    const now = Date.now();
    const sessionId = await insertSession(db, {
      workspaceId,
      status: "stopped",
      startedAt: new Date(now - 500).toISOString(),
      endedAt: new Date(now).toISOString(),
      triggerType: "fix-and-merge",
      stats: JSON.stringify({ inputTokens: 0, outputTokens: 0 }),
    });

    const sessionManager = createMockSessionManager();
    const git = makeGit({
      getConflictingFiles: async () => ["src/foo.ts"],
    });

    const svc = createWorkspaceMergeService({
      database: db,
      getSessionManager: () => sessionManager,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.resolveConflicts(workspaceId)).resolves.toMatchObject({ sessionId: expect.any(String) });

    expect(sessionManager.stopSession).toHaveBeenCalledWith(sessionId);
    expect(sessionManager.startSession).toHaveBeenCalledTimes(1);

    const [workspace] = await db
      .select({ status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(workspace.status).toBe("fixing");
  });

  it("recoverFailedFixAndMergeSessionIfNeeded: resolves fixAndMerge from zero-output fixing zombie", async () => {
    const { workspaceId } = await seedWorkspace(db, { status: "fixing" });
    const now = Date.now();
    const sessionId = await insertSession(db, {
      workspaceId,
      status: "stopped",
      startedAt: new Date(now - 500).toISOString(),
      endedAt: new Date(now).toISOString(),
      triggerType: "fix-and-merge",
      stats: JSON.stringify({ inputTokens: 0, outputTokens: 0 }),
    });

    const sessionManager = createMockSessionManager();
    const git = makeGit({
      getCurrentBranch: async () => "master",
    });

    const svc = createWorkspaceMergeService({
      database: db,
      getSessionManager: () => sessionManager,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.fixAndMerge(workspaceId, "merge conflict")).resolves.toMatchObject({ sessionId: expect.any(String) });

    expect(sessionManager.stopSession).toHaveBeenCalledWith(sessionId);
    expect(sessionManager.startSession).toHaveBeenCalledTimes(1);

    const [workspace] = await db
      .select({ status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(workspace.status).toBe("fixing");
  });

  it("recoverZeroOutputRunningFixAndMergeSession: resolves fixAndMerge from a running zombie session with zero output", async () => {
    const { workspaceId } = await seedWorkspace(db, { status: "fixing" });
    const now = Date.now();
    const sessionId = await insertSession(db, {
      workspaceId,
      status: "running",
      startedAt: new Date(now - 120_000).toISOString(),
      triggerType: "fix-and-merge",
    });

    const sessionManager = createMockSessionManager();
    const git = makeGit({
      getCurrentBranch: async () => "master",
      rebaseOntoBase: vi.fn(async () => ({ success: true })),
      syncBranchToHead: vi.fn(async () => false),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      getSessionManager: () => sessionManager,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.fixAndMerge(workspaceId, "merge conflict")).resolves.toMatchObject({ sessionId: expect.any(String) });

    expect(sessionManager.stopSession).toHaveBeenCalledWith(sessionId);
    expect(sessionManager.startSession).toHaveBeenCalledTimes(1);

    const [workspace] = await db
      .select({ status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(workspace.status).toBe("fixing");
  });
});

describe("resolveMergeState — already-merged (mergedAt set), git-verified (#820)", () => {
  it("returns already-merged when mergedAt is set AND the branch tip is genuinely an ancestor of base", async () => {
    const ws = makeWorkspace({ mergedAt: new Date().toISOString(), status: "idle" });
    const git = makeGitForStateMachine({
      checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: true, branchSha: "sha-branch", baseSha: "sha-base" })),
    });
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never });
    expect(result.kind).toBe("already-merged");
    // The flag is now trust-but-verified: the ancestry check MUST run before honoring mergedAt.
    expect(git.checkBranchTipIsAncestor).toHaveBeenCalled();
  });

  it("honors mergedAt when the branch ref is already gone (merged-and-deleted by cleanup)", async () => {
    const ws = makeWorkspace({ mergedAt: new Date().toISOString(), status: "closed" });
    const git = makeGitForStateMachine({
      checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: false, branchSha: null, reason: "branch-not-found" })),
    });
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never });
    expect(result.kind).toBe("already-merged");
  });

  it("does NOT short-circuit to already-merged when mergedAt is set but the branch is NOT an ancestor (stale flag — silent-merge-loss guard)", async () => {
    // The #820 vector: a stale mergedAt while the branch still holds unmerged work. Short-circuiting
    // would delete the branch + mark the issue Done and lose the work. The branch still exists
    // (branchSha present) and is not an ancestor, so resolveMergeState must re-resolve instead.
    const ws = makeWorkspace({ mergedAt: new Date().toISOString(), status: "idle" });
    const git = makeGitForStateMachine({
      checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: false, branchSha: "sha-branch", baseSha: "sha-base" })),
    });
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never });
    expect(result.kind).not.toBe("already-merged");
    expect(result.kind).toBe("proceed"); // re-resolves to an actual merge, no silent loss
  });
});

describe("resolveMergeState — direct-close", () => {
  it("returns direct-close for isDirect workspaces", async () => {
    const ws = makeWorkspace({ isDirect: true });
    const git = makeGitForStateMachine();
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never });
    expect(result.kind).toBe("direct-close");
  });
});

describe("resolveMergeState — reconcile (branch already ancestor)", () => {
  it("returns reconcile when branch tip is ancestor with ≥1 unique commit", async () => {
    const ws = makeWorkspace();
    const git = makeGitForStateMachine({
      checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: true, branchSha: "sha-branch", baseSha: "sha-base" })),
      countUniqueCommits: vi.fn(async () => 3),
    });
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never });
    expect(result.kind).toBe("reconcile");
    if (result.kind === "reconcile") {
      expect(result.branchSha).toBe("sha-branch");
      expect(result.baseSha).toBe("sha-base");
      expect(result.uniqueCommits).toBe(3);
    }
  });

  it("returns reconcile when a landed branch is an ancestor with 0 current-base unique commits", async () => {
    const ws = makeWorkspace({ baseCommitSha: "base-sha" });
    const git = makeGitForStateMachine({
      checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: true, branchSha: "sha-branch", baseSha: "sha-base" })),
      countUniqueCommits: vi.fn(async (_repo: string, baseSha: string) => baseSha === "base-sha" ? 1 : 0),
    });
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never });
    expect(result.kind).toBe("reconcile");
    if (result.kind === "reconcile") {
      expect(result.branchSha).toBe("sha-branch");
      expect(result.baseSha).toBe("sha-base");
      expect(result.uniqueCommits).toBe(0);
    }
  });

  it("returns clean-ancestor when branch equals the base head and has 0 unique commits", async () => {
    const ws = makeWorkspace();
    const git = makeGitForStateMachine({
      checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: true, branchSha: "same-sha", baseSha: "same-sha" })),
      countUniqueCommits: vi.fn(async () => 0),
    });
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never });
    expect(result.kind).toBe("clean-ancestor");
    if (result.kind === "clean-ancestor") {
      expect(result.branchSha).toBe("same-sha");
      expect(result.baseSha).toBe("same-sha");
      expect(result.uniqueCommits).toBe(0);
    }
  });

  it("returns reconcile when workingDir is missing and landed branch has 0 current-base unique commits", async () => {
    const ws = makeWorkspace({ workingDir: null, baseCommitSha: "base-sha" });
    const checkBranchTipIsAncestor = vi.fn(async () => ({ isAncestor: true, branchSha: "sha-branch", baseSha: "sha-base" }));
    const countUniqueCommits = vi.fn(async (_repo: string, baseSha: string) => baseSha === "base-sha" ? 1 : 0);
    const git = makeGitForStateMachine({ checkBranchTipIsAncestor, countUniqueCommits });
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never });
    expect(result.kind).toBe("reconcile");
    expect(checkBranchTipIsAncestor).toHaveBeenCalled();
    expect(countUniqueCommits).toHaveBeenCalled();
  });
});

describe("resolveMergeState — conflict-ready (direct conflict detection)", () => {
  it("returns conflict-ready when read-only branch detection finds conflicts", async () => {
    const ws = makeWorkspace();
    const git = makeGitForStateMachine({
      detectConflictsByBranch: vi.fn(async () => ({ hasConflicts: true, conflictingFiles: ["src/foo.ts", "src/bar.ts"] })),
    });
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never });
    expect(result.kind).toBe("conflict-ready");
    if (result.kind === "conflict-ready") {
      expect(result.conflictFiles).toEqual(["src/foo.ts", "src/bar.ts"]);
      expect(result.behindCount).toBeUndefined();
      expect(result.error).toBeInstanceOf(WorkspaceError);
      expect(result.error.data).toMatchObject({ mergeReason: "conflict" });
    }
  });

  it("does not set behindCount on a direct conflict (branch is up-to-date)", async () => {
    const ws = makeWorkspace();
    const git = makeGitForStateMachine({
      countBehindCommits: vi.fn(async () => 0),
      detectConflictsByBranch: vi.fn(async () => ({ hasConflicts: true, conflictingFiles: ["src/x.ts"] })),
    });
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never });
    if (result.kind === "conflict-ready") {
      expect(result.behindCount).toBeUndefined();
    }
  });
});

describe("resolveMergeState — conflict-ready (behind base), read-only detection (#761)", () => {
  it("returns conflict-ready with behindCount from READ-ONLY detection, never rebasing", async () => {
    const ws = makeWorkspace();
    const rebaseOntoBase = vi.fn(async () => ({ success: false, conflictingFiles: ["src/service.ts"] }));
    const abortRebase = vi.fn(async () => {});
    const git = makeGitForStateMachine({
      countBehindCommits: vi.fn(async () => 5),
      // The real conflict signal now comes from the read-only branch-level merge-tree.
      detectConflictsByBranch: vi.fn(async () => ({ hasConflicts: true, conflictingFiles: ["src/service.ts"] })),
      rebaseOntoBase,
      abortRebase,
    });
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never });
    expect(result.kind).toBe("conflict-ready");
    if (result.kind === "conflict-ready") {
      expect(result.behindCount).toBe(5);
      expect(result.conflictFiles).toEqual(["src/service.ts"]);
      expect(result.error.data).toMatchObject({ mergeReason: "conflict", behindCount: 5 });
    }
    // The destructive in-place rebase that caused the re-conflict loop must not run.
    expect(rebaseOntoBase).not.toHaveBeenCalled();
    expect(abortRebase).not.toHaveBeenCalled();
  });

  it("a behind-but-mechanically-mergeable branch PROCEEDS instead of looping on rebase", async () => {
    const ws = makeWorkspace();
    const rebaseOntoBase = vi.fn(async () => ({ success: true }));
    const git = makeGitForStateMachine({
      countBehindCommits: vi.fn(async () => 3),
      // merge-tree of branch→base is clean even though base moved past the branch.
      detectConflictsByBranch: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
      rebaseOntoBase,
    });
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never });
    expect(result.kind).toBe("proceed");
    expect(rebaseOntoBase).not.toHaveBeenCalled();
  });
});

describe("resolveMergeState — error-skip (dirty main checkout)", () => {
  it("returns error-skip when main checkout has uncommitted tracked changes", async () => {
    const ws = makeWorkspace();
    const git = makeGitForStateMachine({
      getUncommittedTrackedChanges: vi.fn(async () => ["packages/server/src/index.ts"]),
    });
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never });
    expect(result.kind).toBe("error-skip");
    if (result.kind === "error-skip") {
      expect(result.error.data).toMatchObject({ mergeReason: "dirty_main" });
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  it("checks dirty-main even when workingDir is missing", async () => {
    const ws = makeWorkspace({ workingDir: null });
    const git = makeGitForStateMachine({
      getUncommittedTrackedChanges: vi.fn(async () => ["packages/server/src/index.ts"]),
    });
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never });
    expect(result.kind).toBe("error-skip");
    if (result.kind === "error-skip") {
      expect(result.error.data).toMatchObject({ mergeReason: "dirty_main" });
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  it("proceeds when main checkout is clean", async () => {
    const ws = makeWorkspace();
    const git = makeGitForStateMachine({
      getUncommittedTrackedChanges: vi.fn(async () => []),
    });
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never });
    expect(result.kind).toBe("proceed");
  });
});

describe("resolveMergeState — proceed (all checks pass)", () => {
  it("returns proceed when branch has no conflicts and is up-to-date", async () => {
    const ws = makeWorkspace();
    const git = makeGitForStateMachine();
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never });
    expect(result.kind).toBe("proceed");
  });
});

// ─── auto_merge_in_review gate (#693) ─────────────────────────────────────────

describe("resolveMergeState — auto_merge_in_review bypasses readyForMerge gate", () => {
  it("returns not-approved when readyForMerge=false and autoMergeInReview=false (manual gate preserved)", async () => {
    const ws = makeWorkspace({ readyForMerge: false });
    const git = makeGitForStateMachine();
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never, autoMergeInReview: false });
    expect(result.kind).toBe("not-approved");
  });

  it("returns not-approved when readyForMerge=false and autoMergeInReview omitted (default gate preserved)", async () => {
    const ws = makeWorkspace({ readyForMerge: false });
    const git = makeGitForStateMachine();
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never });
    expect(result.kind).toBe("not-approved");
  });

  it("proceeds past the readyForMerge gate when autoMergeInReview=true and readyForMerge=false", async () => {
    const ws = makeWorkspace({ readyForMerge: false });
    const git = makeGitForStateMachine();
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never, autoMergeInReview: true });
    // Should not be not-approved — the gate is bypassed and the merge can proceed
    expect(result.kind).not.toBe("not-approved");
    // With a clean, non-conflicting branch it should reach proceed
    expect(result.kind).toBe("proceed");
  });

  it("does not bypass the gate for isDirect workspaces (they skip readyForMerge unconditionally)", async () => {
    const ws = makeWorkspace({ isDirect: true, readyForMerge: false });
    const git = makeGitForStateMachine();
    const result = await resolveMergeState(ws, "/repo", "master", { gitService: git as never, autoMergeInReview: false });
    // isDirect always returns direct-close, regardless of readyForMerge / autoMergeInReview
    expect(result.kind).toBe("direct-close");
  });
});

// ─── Integration: conflict-ready through mergeWorkspace (#610) ───────────────

describe("MergeService — conflict-ready clears readyForMerge and throws", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("throws CONFLICT with mergeReason=conflict and clears readyForMerge flag", async () => {
    const { workspaceId } = await seedWorkspace(db, { readyForMerge: true });
    const git = makeGit({
      detectConflicts: async () => ({ hasConflicts: true, conflictingFiles: ["src/foo.ts"] }),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).rejects.toMatchObject({
      code: "CONFLICT",
      data: expect.objectContaining({ mergeReason: "conflict" }),
    });

    const [ws] = await db.select({ readyForMerge: workspaces.readyForMerge })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.readyForMerge).toBe(false);
  });

  it("does not call mergeBranch when conflicts are detected", async () => {
    const { workspaceId } = await seedWorkspace(db, { readyForMerge: true });
    const mergeBranch = vi.fn(async () => "");
    const git = makeGit({
      mergeBranch,
      detectConflicts: async () => ({ hasConflicts: true, conflictingFiles: ["src/foo.ts"] }),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).rejects.toThrow();
    expect(mergeBranch).not.toHaveBeenCalled();
  });
});

describe("MergeService — error-skip (dirty main) throws without git merge", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("throws CONFLICT with mergeReason=dirty_main when main checkout is dirty", async () => {
    const { workspaceId } = await seedWorkspace(db, { readyForMerge: true });
    const mergeBranch = vi.fn(async () => "");
    const git = makeGit({
      mergeBranch,
      getUncommittedTrackedChanges: async () => ["packages/server/src/index.ts"],
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).rejects.toMatchObject({
      code: "CONFLICT",
      data: expect.objectContaining({ mergeReason: "dirty_main" }),
    });
    expect(mergeBranch).not.toHaveBeenCalled();
  });
});

// ─── mergeWorkspaceDeduped: concurrent-request deduplication (#631) ───────────

describe("MergeService — mergeWorkspaceDeduped deduplicates concurrent requests", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("returns the same promise for concurrent calls to the same workspace", async () => {
    const { workspaceId } = await seedWorkspace(db);
    let mergeCallCount = 0;
    const git = makeGit({
      mergeBranch: vi.fn(async () => {
        mergeCallCount++;
        return "Merge made by the 'ort' strategy.";
      }),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    const [r1, r2] = await Promise.all([
      svc.mergeWorkspaceDeduped(workspaceId),
      svc.mergeWorkspaceDeduped(workspaceId),
    ]);

    expect(mergeCallCount).toBe(1);
    expect(r1).toBe(r2);
  });

  it("allows a second merge after the first completes", async () => {
    const { workspaceId } = await seedWorkspace(db);
    let mergeCallCount = 0;
    const git = makeGit({
      mergeBranch: vi.fn(async () => {
        mergeCallCount++;
        return "Merge made by the 'ort' strategy.";
      }),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await svc.mergeWorkspaceDeduped(workspaceId);
    // First call merged and closed the workspace; second call should hit already-merged path
    await svc.mergeWorkspaceDeduped(workspaceId);

    // Two separate invocations (not deduplicated since first completed)
    expect(mergeCallCount).toBe(1);
  });

  it("propagates rejections to all concurrent callers", async () => {
    const { workspaceId } = await seedWorkspace(db);
    const git = makeGit({
      getUncommittedTrackedChanges: async () => ["dirty.ts"],
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    const [p1, p2] = [
      svc.mergeWorkspaceDeduped(workspaceId),
      svc.mergeWorkspaceDeduped(workspaceId),
    ];

    await expect(p1).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(p2).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
