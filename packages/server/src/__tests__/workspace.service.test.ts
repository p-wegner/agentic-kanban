import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { projects, projectStatuses, issues, workspaces, preferences, sessions, issueComments } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import { createWorkspaceService, type GitService } from "../services/workspace.service.js";
import { workspaceServicesService } from "../services/workspace-services.service.js";
import { activeMerges, MERGE_LOCK_STALE_MS } from "../services/workspace-internals.js";
import { getWorkspaceDetails } from "../repositories/workspace.repository.js";

// Mock process-cleanup so teardown doesn't run real wmic/lsof/netstat in unit tests.
vi.mock("../services/process-cleanup.js", () => ({
  killProcessesInDir: vi.fn(async () => 0),
  killProcessesOnPorts: vi.fn(async () => 0),
}));

/**
 * Unit tests for workspace.service using an in-memory SQLite DB plus an injected
 * fake git service and session manager. No real git, no subprocesses, no E2E.
 */

/**
 * Drain the deferred provision+launch chain (setImmediate → async provisioning →
 * service_state persist → ticket-context write → agent launch). Since the chain has
 * several real fs/DB awaits before the agent launches, flush multiple event-loop turns.
 */
async function flushDeferred(times = 25): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Seed a project (with Todo/In Progress/Done statuses) and one issue. */
async function seedProjectAndIssue(
  db: TestDb,
  opts: { priority?: string } = {},
): Promise<{ projectId: string; issueId: string }> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const issueId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Test Project",
    repoPath: "/tmp/test-repo",
    repoName: "test-repo",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const statusDefs = [
    { name: "Todo", sortOrder: 0, isDefault: true },
    { name: "In Progress", sortOrder: 1, isDefault: false },
    { name: "Done", sortOrder: 2, isDefault: false },
  ];
  const statusIds: Record<string, string> = {};
  for (const s of statusDefs) {
    const id = randomUUID();
    statusIds[s.name] = id;
    await db.insert(projectStatuses).values({
      id,
      projectId,
      name: s.name,
      sortOrder: s.sortOrder,
      isDefault: s.isDefault,
      createdAt: now,
    });
  }

  await db.insert(issues).values({
    id: issueId,
    issueNumber: 1,
    title: "Implement feature",
    description: "Do the thing",
    priority: opts.priority ?? "medium",
    sortOrder: 0,
    statusId: statusIds["Todo"],
    projectId,
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId };
}

/**
 * Seed a project with the full status pipeline (Todo → In Progress → In Review → Done)
 * and place the issue in "In Review" — mirroring the board state just before a merge.
 */
async function seedProjectAndIssueInReview(
  db: TestDb,
): Promise<{ projectId: string; issueId: string; statusIds: Record<string, string> }> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const issueId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Test Project",
    repoPath: "/tmp/test-repo",
    repoName: "test-repo",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const statusDefs = [
    { name: "Todo", sortOrder: 0, isDefault: true },
    { name: "In Progress", sortOrder: 1, isDefault: false },
    { name: "In Review", sortOrder: 2, isDefault: false },
    { name: "Done", sortOrder: 3, isDefault: false },
  ];
  const statusIds: Record<string, string> = {};
  for (const s of statusDefs) {
    const id = randomUUID();
    statusIds[s.name] = id;
    await db.insert(projectStatuses).values({
      id,
      projectId,
      name: s.name,
      sortOrder: s.sortOrder,
      isDefault: s.isDefault,
      createdAt: now,
    });
  }

  await db.insert(issues).values({
    id: issueId,
    issueNumber: 1,
    title: "Implement feature",
    description: "Do the thing",
    priority: "medium",
    sortOrder: 0,
    statusId: statusIds["In Review"],
    projectId,
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId, statusIds };
}

/**
 * Build a fake git service. Only the methods exercised by the tested paths need
 * real behavior; the rest are no-op vi.fn()s. Overrides let each test customize.
 */
function createFakeGitService(overrides: Partial<GitService> = {}): GitService {
  return {
    createWorktree: vi.fn(async () => "/tmp/test-repo/.worktrees/feature-1"),
    getCurrentBranch: vi.fn(async () => "main"),
    getHeadCommitSha: vi.fn(async () => "abc123"),
    revParse: vi.fn(async () => "base-sha-123"),
    removeWorktree: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    getUncommittedTrackedChanges: vi.fn(async () => []),
    syncBranchToHead: vi.fn(async () => true),
    mergeBranch: vi.fn(async () => "Merge made by the 'ort' strategy."),
    pruneWorktrees: vi.fn(async () => {}),
    rebaseOntoBase: vi.fn(async () => ({ success: true })),
    abortRebase: vi.fn(async () => {}),
    // Stateful ancestry: pre-merge resolveMergeState passes the worktreeDir (4th arg) and
    // must see the branch as NOT yet merged so the merge proceeds; the post-merge invariant
    // check (verifyPostMergeAncestry) calls WITHOUT a worktreeDir and must see it as merged.
    checkBranchTipIsAncestor: vi.fn(async (_repo: string, _branch: string, _base: string, worktreeDir?: string) =>
      worktreeDir !== undefined
        ? { isAncestor: false, branchSha: "branch-sha-abc", baseSha: "base-sha-123" }
        : { isAncestor: true, branchSha: "branch-sha-abc", baseSha: "base-sha-123" },
    ),
    countUniqueCommits: vi.fn(async () => 1),
    countBehindCommits: vi.fn(async () => 0),
    autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
    getChangedFilesBetween: vi.fn(async () => []),
    getCommitSummariesBetween: vi.fn(async () => []),
    // Intentionally NOT mocking detectConflictsByBranch: the conflict-detection path prefers it
    // when present, which would shadow per-test `detectConflicts` overrides. Leaving it absent
    // makes detectConflictsReadOnly fall through to `detectConflicts` (the override surface).
    detectAppendOnlyResolvableConflicts: vi.fn(async () => null),
    commitPaths: vi.fn(async () => true),
    mergeBaseIntoBranch: vi.fn(async () => ({ success: true })),
    getDiffFromRepo: vi.fn(async () => ""),
    getDiff: vi.fn(async () => ""),
    ...overrides,
  } as unknown as GitService;
}

describe("workspace.service", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  afterEach(() => {
    // Clear the in-process merge lock so a timed-out test doesn't poison subsequent tests.
    activeMerges.clear();
  });

  describe("createWorkspace", () => {
    it("creates a worktree, inserts the workspace, moves the issue to In Progress, and launches the agent", async () => {
      const { issueId } = await seedProjectAndIssue(db);
      const gitService = createFakeGitService();
      const sessionManager = createMockSessionManager();

      const service = createWorkspaceService({
        database: db,
        getSessionManager: () => sessionManager,
        gitService,
      });

      const result = await service.createWorkspace({ issueId, branch: "feature/ak-1-test" });

      // No error field => success path
      expect(result.error).toBeUndefined();
      expect(result.issueId).toBe(issueId);
      expect(result.workingDir).toBe("/tmp/test-repo/.worktrees/feature-1");
      // Agent launch is deferred via setImmediate (#587) so the synchronous result
      // carries no sessionId — the launch fires after the response is returned.
      expect((result as { sessionId?: string }).sessionId).toBeUndefined();

      // Worktree was created off the project default branch
      expect(gitService.revParse).toHaveBeenCalledWith("/tmp/test-repo", "main");
      expect(gitService.createWorktree).toHaveBeenCalledWith("/tmp/test-repo", "feature/ak-1-test", "main");
      // Agent launch happened (deferred — flush the provision+launch chain first)
      await flushDeferred();
      expect(sessionManager.startSession).toHaveBeenCalledOnce();

      // Workspace row persisted
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, result.id));
      expect(wsRows).toHaveLength(1);
      expect(wsRows[0].status).toBe("active");
      expect(wsRows[0].baseCommitSha).toBe("base-sha-123");

      // Issue moved to In Progress
      const issueRow = await db.select().from(issues).where(eq(issues.id, issueId));
      const statusRow = await db.select().from(projectStatuses).where(eq(projectStatuses.id, issueRow[0].statusId));
      expect(statusRow[0].name).toBe("In Progress");
    });

    it("injects the ticket context as CLAUDE.local.md into the worktree", async () => {
      const worktreeDir = await mkdtemp(join(tmpdir(), "ak-ws-ctx-"));
      try {
        const { issueId } = await seedProjectAndIssue(db);
        const gitService = createFakeGitService({
          createWorktree: vi.fn(async () => worktreeDir),
        });
        const sessionManager = createMockSessionManager();

        const service = createWorkspaceService({
          database: db,
          getSessionManager: () => sessionManager,
          gitService,
        });

        const result = await service.createWorkspace({ issueId, branch: "feature/ak-1-test" });
        expect(result.error).toBeUndefined();

        // Ticket-context write is deferred (with provisioning + launch) off the hot path.
        await flushDeferred();
        const ctx = (await readFile(join(worktreeDir, "CLAUDE.local.md"), "utf-8")).trim();
        // Seed issue: number 1, title "Implement feature", description "Do the thing"
        expect(ctx).toContain("# Ticket #1: Implement feature");
        expect(ctx).toContain("Do the thing");
        expect(sessionManager.startSession).toHaveBeenCalledWith(expect.objectContaining({
          contextFiles: [join(worktreeDir, "CLAUDE.local.md")],
        }));
      } finally {
        await rm(worktreeDir, { recursive: true, force: true });
      }
    });

    it("does not store the Claude profile as the displayed profile for default Codex workspaces", async () => {
      const { issueId } = await seedProjectAndIssue(db);
      await db.insert(preferences).values([
        { key: "provider", value: "codex" },
        { key: "claude_profile", value: "anth" },
        { key: "codex_profile", value: "" },
      ]);
      const sessionManager = createMockSessionManager();

      const service = createWorkspaceService({
        database: db,
        getSessionManager: () => sessionManager,
        gitService: createFakeGitService(),
      });

      const result = await service.createWorkspace({ issueId, branch: "feature/ak-1-codex" });

      expect(result.error).toBeUndefined();
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, result.id));
      expect(wsRows[0].provider).toBe("codex");
      expect(wsRows[0].claudeProfile).toBeNull();
      // Agent launch is deferred (#587) — flush the provision+launch chain before asserting.
      await flushDeferred();
      expect(sessionManager.startSession).toHaveBeenCalledWith(expect.objectContaining({
        provider: "codex",
        profile: undefined,
      }));
    });

    it("stores the selected Codex profile for ticket card display", async () => {
      const { issueId } = await seedProjectAndIssue(db);
      await db.insert(preferences).values([
        { key: "provider", value: "codex" },
        { key: "claude_profile", value: "anth" },
        { key: "codex_profile", value: "fast" },
      ]);
      const sessionManager = createMockSessionManager();

      const service = createWorkspaceService({
        database: db,
        getSessionManager: () => sessionManager,
        gitService: createFakeGitService(),
      });

      const result = await service.createWorkspace({ issueId, branch: "feature/ak-1-codex-fast" });

      expect(result.error).toBeUndefined();
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, result.id));
      expect(wsRows[0].provider).toBe("codex");
      expect(wsRows[0].claudeProfile).toBe("fast");
      // Agent launch is deferred (#587) — flush the provision+launch chain before asserting.
      await flushDeferred();
      expect(sessionManager.startSession).toHaveBeenCalledWith(expect.objectContaining({
        provider: "codex",
        profile: { provider: "codex", name: "fast" },
      }));
    });

    it("marks the workspace idle with a launch error when the deferred agent spawn fails", async () => {
      const { issueId } = await seedProjectAndIssue(db);
      const gitService = createFakeGitService();
      const sessionManager = createMockSessionManager();
      // Make agent launch blow up
      (sessionManager.startSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("spawn ENOENT"));

      const service = createWorkspaceService({
        database: db,
        getSessionManager: () => sessionManager,
        gitService,
      });

      // Agent launch is deferred (#587): createWorkspace resolves with the record, and the
      // spawn failure is handled in the background callback (no synchronous throw/rollback).
      const result = await service.createWorkspace({ issueId, branch: "feature/ak-1-fail" });
      expect(result.error).toBeUndefined();

      // Let the deferred chain fire so the failing launch + status update run.
      await flushDeferred();

      // The workspace row remains (relaunchable) and is marked idle with the launch error.
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, result.id));
      expect(wsRows).toHaveLength(1);
      expect(wsRows[0].status).toBe("idle");
      expect(wsRows[0].latestLaunchError).toContain("spawn ENOENT");
    });

    it("returns an error result without persisting a workspace when worktree setup fails before insert", async () => {
      // Pre-insert failure path: createWorktree throws before the DB row is written,
      // so the catch block calls handleCreateFailure. This is the path that hit the
      // `planMode is not defined` ReferenceError — planMode must be in catch-block scope.
      const { issueId } = await seedProjectAndIssue(db, { priority: "high" });
      const gitService = createFakeGitService({
        createWorktree: vi.fn(async () => {
          throw new Error("worktree setup boom");
        }),
      });
      const sessionManager = createMockSessionManager();
      const service = createWorkspaceService({
        database: db,
        getSessionManager: () => sessionManager,
        gitService,
      });

      // Must not throw — the one-step endpoint returns 201 with an error field.
      const result = await service.createWorkspace({ issueId, branch: "feature/ak-1-setup-fail" });

      expect(result.id).toBeDefined();
      expect(result.status).toBe("error");
      expect(result.error).toContain("worktree setup boom");
      // planMode was correctly in scope and defaulted on for the high-priority issue.
      expect(result.planMode).toBe(true);
      expect(sessionManager.startSession).not.toHaveBeenCalled();

      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, result.id));
      expect(wsRows).toHaveLength(0);
    });

    it("rolls back the workspace row and removes the worktree when a later create DB write fails", async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      await db
        .delete(projectStatuses)
        .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, "In Progress")));
      const gitService = createFakeGitService();
      const sessionManager = createMockSessionManager();
      const service = createWorkspaceService({
        database: db,
        getSessionManager: () => sessionManager,
        gitService,
      });

      const result = await service.createWorkspace({ issueId, branch: "feature/ak-1-status-fail" });

      expect(result.status).toBe("error");
      expect(result.error).toContain("has no In Progress status");
      expect(gitService.removeWorktree).toHaveBeenCalledWith(
        "/tmp/test-repo",
        "/tmp/test-repo/.worktrees/feature-1",
      );
      expect(sessionManager.startSession).not.toHaveBeenCalled();

      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, result.id));
      expect(wsRows).toHaveLength(0);
    });

    it("auto-generates branch name from issue when branch is omitted", async () => {
      const { issueId } = await seedProjectAndIssue(db);
      const gitService = createFakeGitService();
      const sessionManager = createMockSessionManager();

      const service = createWorkspaceService({
        database: db,
        getSessionManager: () => sessionManager,
        gitService,
      });

      // No branch provided — should derive from issue number (1) and title ("Implement feature")
      const result = await service.createWorkspace({ issueId });

      expect(result.error).toBeUndefined();
      expect(result.branch).toMatch(/^feature\/ak-1-/);
      expect(result.branch).toBe("feature/ak-1-implement-feature");
      expect(gitService.createWorktree).toHaveBeenCalledWith(
        "/tmp/test-repo",
        "feature/ak-1-implement-feature",
        "main",
      );
    });

    it("uses the explicit branch when provided, regardless of issue title", async () => {
      const { issueId } = await seedProjectAndIssue(db);
      const gitService = createFakeGitService();
      const sessionManager = createMockSessionManager();

      const service = createWorkspaceService({
        database: db,
        getSessionManager: () => sessionManager,
        gitService,
      });

      const result = await service.createWorkspace({ issueId, branch: "feature/my-custom-branch" });

      expect(result.error).toBeUndefined();
      expect(result.branch).toBe("feature/my-custom-branch");
      expect(gitService.createWorktree).toHaveBeenCalledWith(
        "/tmp/test-repo",
        "feature/my-custom-branch",
        "main",
      );
    });
  });

  describe("mergeWorkspace", () => {
    /** Create an active, non-direct workspace row ready to merge. */
    async function seedWorkspaceForMerge(projectId: string, issueId: string): Promise<string> {
      const now = new Date().toISOString();
      const id = randomUUID();
      await db.insert(workspaces).values({
        id,
        issueId,
        branch: "feature/ak-1-test",
        workingDir: "/tmp/test-repo/.worktrees/feature-1",
        baseBranch: "main",
        isDirect: false,
        status: "active",
        readyForMerge: true,
        provider: "claude",
        createdAt: now,
        updatedAt: now,
      });
      return id;
    }

    it("merges the branch, cleans up the worktree, closes the workspace, and moves the issue to Done", { timeout: 30000 }, async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const wsId = await seedWorkspaceForMerge(projectId, issueId);
      const gitService = createFakeGitService();

      const createBackup = vi.fn(async () => ({}));
      const processKiller = vi.fn(async () => 0);
      const service = createWorkspaceService({ database: db, gitService, createBackup, processKiller });

      const result = await service.mergeWorkspace(wsId);

      // Post-merge cleanup (worktree removal, workingDir clear) is deferred to the background
      // (#407) so the HTTP response returns immediately — flush it before asserting cleanup.
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(result.id).toBe(wsId);
      expect(result.mergeOutput).toContain("Merge made");
      expect(gitService.mergeBranch).toHaveBeenCalledWith(
        "/tmp/test-repo",
        "feature/ak-1-test",
        "main",
        expect.objectContaining({ deferWorkingTreeSync: true, autoResolveAppendConflicts: true }),
      );
      expect(gitService.removeWorktree).toHaveBeenCalled();

      // Workspace closed
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
      expect(wsRows[0].status).toBe("closed");
      expect(wsRows[0].workingDir).toBeNull();

      // Issue moved to Done
      const issueRow = await db.select().from(issues).where(eq(issues.id, issueId));
      const statusRow = await db.select().from(projectStatuses).where(eq(projectStatuses.id, issueRow[0].statusId));
      expect(statusRow[0].name).toBe("Done");

      const events = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(events).toEqual([
        expect.objectContaining({
          kind: "merge-attempt",
          author: "system",
          workspaceId: wsId,
          body: expect.stringContaining("Merged feature/ak-1-test into main"),
        }),
      ]);
      expect(JSON.parse(events[0].payload ?? "{}")).toEqual(expect.objectContaining({
        eventType: "merged",
        workspaceId: wsId,
        commitSha: "base-sha-123",
      }));
    });

    it("closes the workspace when a retry finds the branch is already merged", { timeout: 30000 }, async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const wsId = await seedWorkspaceForMerge(projectId, issueId);
      const gitService = createFakeGitService({
        mergeBranch: vi.fn(async () => "Branch 'feature/ak-1-test' is already merged into main (plumbing-merge: abc123)"),
      });

      const service = createWorkspaceService({
        database: db,
        gitService,
        createBackup: vi.fn(async () => ({})),
        processKiller: vi.fn(async () => 0),
      });

      const result = await service.mergeWorkspace(wsId);

      // Post-merge cleanup is deferred to the background (#407) — flush before asserting it.
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(result.mergeOutput).toContain("already merged");
      expect(gitService.mergeBranch).toHaveBeenCalledWith(
        "/tmp/test-repo",
        "feature/ak-1-test",
        "main",
        expect.objectContaining({ deferWorkingTreeSync: true, autoResolveAppendConflicts: true }),
      );
      expect(gitService.removeWorktree).toHaveBeenCalledWith("/tmp/test-repo", "/tmp/test-repo/.worktrees/feature-1");
      expect(gitService.deleteBranch).toHaveBeenCalledWith("/tmp/test-repo", "feature/ak-1-test");

      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
      expect(wsRows[0].status).toBe("closed");
      expect(wsRows[0].workingDir).toBeNull();
      expect(wsRows[0].mergedAt).toBeTruthy();

      const issueRow = await db.select().from(issues).where(eq(issues.id, issueId));
      const statusRow = await db.select().from(projectStatuses).where(eq(projectStatuses.id, issueRow[0].statusId));
      expect(statusRow[0].name).toBe("Done");
    });

    it("reconciles a workspace that already has mergedAt even when the branch ref is missing", { timeout: 30000 }, async () => {
      const { issueId } = await seedProjectAndIssue(db);
      const now = new Date().toISOString();
      const wsId = randomUUID();
      const mergedAt = "2026-05-31T18:02:06.010Z";
      await db.insert(workspaces).values({
        id: wsId,
        issueId,
        branch: "feature/ak-1-test",
        workingDir: null,
        baseBranch: "main",
        isDirect: false,
        status: "closed",
        provider: "claude",
        mergedAt,
        createdAt: now,
        updatedAt: now,
      });
      const gitService = createFakeGitService({
        deleteBranch: vi.fn(async () => {
          throw new Error("git branch -D feature/ak-1-test failed: branch not found");
        }),
        mergeBranch: vi.fn(async () => {
          throw new Error("git rev-parse feature/ak-1-test failed: unknown revision");
        }),
      });

      const service = createWorkspaceService({
        database: db,
        gitService,
        createBackup: vi.fn(async () => ({})),
        processKiller: vi.fn(async () => 0),
      });

      const result = await service.mergeWorkspace(wsId);

      expect(result.mergeOutput).toContain("already marked as merged");
      expect(result.warnings).toEqual([
        expect.objectContaining({
          step: "delete-branch",
          message: "git branch -D feature/ak-1-test failed: branch not found",
          recoverable: true,
        }),
      ]);
      expect(gitService.mergeBranch).not.toHaveBeenCalled();
      expect(gitService.deleteBranch).toHaveBeenCalledWith("/tmp/test-repo", "feature/ak-1-test");

      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
      expect(wsRows[0].status).toBe("closed");
      expect(wsRows[0].workingDir).toBeNull();
      expect(wsRows[0].mergedAt).toBe(mergedAt);
      expect(wsRows[0].closedAt).toBeTruthy();

      const issueRow = await db.select().from(issues).where(eq(issues.id, issueId));
      const statusRow = await db.select().from(projectStatuses).where(eq(projectStatuses.id, issueRow[0].statusId));
      expect(statusRow[0].name).toBe("Done");
    });

    it("closes the workspace and moves the issue to Done when post-merge changed-file detection fails", { timeout: 30000 }, async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const wsId = await seedWorkspaceForMerge(projectId, issueId);
      const gitService = createFakeGitService({
        getChangedFilesBetween: vi.fn(async () => {
          throw new Error("changed-file scan failed after merge");
        }),
      });

      const service = createWorkspaceService({
        database: db,
        gitService,
        createBackup: vi.fn(async () => ({})),
        processKiller: vi.fn(async () => 0),
      });

      const result = await service.mergeWorkspace(wsId);

      expect(result.mergeOutput).toContain("Merge made");
      // Cleanup warnings are deferred to the background — not present in the synchronous response.
      expect((result as { warnings?: unknown }).warnings).toBeUndefined();

      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
      expect(wsRows[0].status).toBe("closed");
      expect(wsRows[0].workingDir).toBeNull();
      expect(wsRows[0].mergedAt).toBeTruthy();

      const issueRow = await db.select().from(issues).where(eq(issues.id, issueId));
      const statusRow = await db.select().from(projectStatuses).where(eq(projectStatuses.id, issueRow[0].statusId));
      expect(statusRow[0].name).toBe("Done");
    });

    it("records the merge before post-merge cleanup runs (DB closed before removeWorktree is called)", { timeout: 30000 }, async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const wsId = await seedWorkspaceForMerge(projectId, issueId);

      // This mock fires in the background task. It verifies that the workspace
      // is already marked as closed/merged (by the synchronous part of doMerge)
      // before any cleanup executes.
      let dbStateWhenCleanupRan: { status: string; workingDir: null | string | undefined; mergedAt: null | string | undefined; issueStatus: string } | null = null;
      const gitService = createFakeGitService({
        removeWorktree: vi.fn(async () => {
          const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
          const issueRow = await db.select().from(issues).where(eq(issues.id, issueId));
          const statusRow = await db.select().from(projectStatuses).where(eq(projectStatuses.id, issueRow[0].statusId));
          dbStateWhenCleanupRan = {
            status: wsRows[0].status,
            workingDir: wsRows[0].workingDir,
            mergedAt: wsRows[0].mergedAt,
            issueStatus: statusRow[0].name,
          };
          throw new Error("connection dropped during cleanup");
        }),
      });

      const service = createWorkspaceService({
        database: db,
        gitService,
        createBackup: vi.fn(async () => ({})),
        processKiller: vi.fn(async () => 0),
      });

      const result = await service.mergeWorkspace(wsId);

      // Synchronous response returns immediately — no warnings in the response.
      expect(result.mergeOutput).toContain("Merge made");
      expect((result as { warnings?: unknown }).warnings).toBeUndefined();

      // Let the background task run.
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Workspace was already in "closed" state when the background cleanup fired.
      expect(dbStateWhenCleanupRan).not.toBeNull();
      expect(dbStateWhenCleanupRan!.status).toBe("closed");
      expect(dbStateWhenCleanupRan!.workingDir).toBeNull();
      expect(dbStateWhenCleanupRan!.mergedAt).toBeTruthy();
      expect(dbStateWhenCleanupRan!.issueStatus).toBe("Done");

      // Warning comment was recorded asynchronously.
      const events = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(events.map((event) => JSON.parse(event.payload ?? "{}").eventType)).toEqual(["merged", "warning"]);
      expect(events[1].body).toContain("recoverable warning");
      expect(events[1].body).toContain("already merged before this response returned");
    });

    it("returns success, closes the workspace, and moves the issue to Done when worktree removal fails after merge", { timeout: 30000 }, async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const wsId = await seedWorkspaceForMerge(projectId, issueId);
      const gitService = createFakeGitService({
        removeWorktree: vi.fn(async () => {
          throw new Error("worktree still busy");
        }),
      });

      const service = createWorkspaceService({
        database: db,
        gitService,
        createBackup: vi.fn(async () => ({})),
        processKiller: vi.fn(async () => 0),
      });

      const result = await service.mergeWorkspace(wsId);

      expect(result.mergeOutput).toContain("Merge made");
      // Cleanup warnings are deferred to the background — not present in the synchronous response.
      expect((result as { warnings?: unknown }).warnings).toBeUndefined();

      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
      expect(wsRows[0].status).toBe("closed");
      expect(wsRows[0].workingDir).toBeNull();
      expect(wsRows[0].mergedAt).toBeTruthy();

      const issueRow = await db.select().from(issues).where(eq(issues.id, issueId));
      const statusRow = await db.select().from(projectStatuses).where(eq(projectStatuses.id, issueRow[0].statusId));
      expect(statusRow[0].name).toBe("Done");
    });

    it("throws a BAD_REQUEST WorkspaceError with the conflicting files when merge conflicts are detected", { timeout: 30000 }, async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const wsId = await seedWorkspaceForMerge(projectId, issueId);
      const gitService = createFakeGitService({
        detectConflicts: vi.fn(async () => ({ hasConflicts: true, conflictingFiles: ["src/foo.ts"] })),
      });

      const service = createWorkspaceService({ database: db, gitService, processKiller: vi.fn(async () => 0) });

      await expect(service.mergeWorkspace(wsId)).rejects.toMatchObject({
        code: "CONFLICT",
        data: { conflictFiles: ["src/foo.ts"] },
      });
      expect(gitService.mergeBranch).not.toHaveBeenCalled();

      const events = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(events).toEqual([
        expect.objectContaining({
          kind: "merge-attempt",
          workspaceId: wsId,
          body: expect.stringContaining("Merge attempt blocked by conflicts"),
        }),
      ]);
      expect(JSON.parse(events[0].payload ?? "{}")).toEqual(expect.objectContaining({
        eventType: "conflict",
        conflictingFiles: ["src/foo.ts"],
      }));

      // Workspace stays active (not closed) on conflict
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
      expect(wsRows[0].status).toBe("active");
    });

    it("reports active merge lock diagnostics while another merge is still fresh", async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const wsId = await seedWorkspaceForMerge(projectId, issueId);
      const gitService = createFakeGitService();
      const startedAtMs = Date.now() - 5_000;
      activeMerges.set("/tmp/test-repo", {
        promise: new Promise(() => {}),
        workspaceId: "old-workspace",
        repoPath: "/tmp/test-repo",
        startedAt: new Date(startedAtMs).toISOString(),
        startedAtMs,
      });

      const service = createWorkspaceService({ database: db, gitService, processKiller: vi.fn(async () => 0) });

      await expect(service.mergeWorkspace(wsId)).rejects.toMatchObject({
        code: "CONFLICT",
        data: {
          repoPath: "/tmp/test-repo",
          activeWorkspaceId: "old-workspace",
          staleAfterMs: MERGE_LOCK_STALE_MS,
          isStale: false,
        },
      });
      expect(gitService.mergeBranch).not.toHaveBeenCalled();
    });

    it("reuses in-flight result when the same workspace retries while merge is still fresh", async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const wsId = await seedWorkspaceForMerge(projectId, issueId);
      const gitService = createFakeGitService({
        getCurrentBranch: vi.fn(async () => "main"),
      });
      let resolveMerge: (result: { id: string; mergeOutput: string }) => void;
      const inFlight = new Promise<{ id: string; mergeOutput: string }>((resolve) => {
        resolveMerge = resolve;
      });
      activeMerges.set("/tmp/test-repo", {
        promise: inFlight,
        workspaceId: wsId,
        repoPath: "/tmp/test-repo",
        startedAt: new Date(Date.now() - 250).toISOString(),
        startedAtMs: Date.now() - 250,
      });

      const service = createWorkspaceService({
        database: db,
        gitService,
        processKiller: vi.fn(async () => 0),
      });

      const mergePromise = service.mergeWorkspace(wsId);
      resolveMerge({
        id: wsId,
        mergeOutput: "already merged",
      });
      const result = await mergePromise;

      expect(result).toEqual(expect.objectContaining({ id: wsId, mergeOutput: "already merged" }));
      expect(gitService.mergeBranch).not.toHaveBeenCalled();
    });

    it("recovers a stale merge lock and proceeds with the merge", async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const wsId = await seedWorkspaceForMerge(projectId, issueId);
      const staleStartedAtMs = Date.now() - MERGE_LOCK_STALE_MS - 1_000;
      activeMerges.set("/tmp/test-repo", {
        promise: Promise.resolve("old merge settled later"),
        workspaceId: "stale-workspace",
        repoPath: "/tmp/test-repo",
        startedAt: new Date(staleStartedAtMs).toISOString(),
        startedAtMs: staleStartedAtMs,
      });

      const gitService = createFakeGitService();
      const service = createWorkspaceService({
        database: db,
        gitService,
        createBackup: vi.fn(async () => ({})),
        processKiller: vi.fn(async () => 0),
      });

      const result = await service.mergeWorkspace(wsId);

      expect(result.id).toBe(wsId);
      expect(gitService.mergeBranch).toHaveBeenCalledWith(
        "/tmp/test-repo",
        "feature/ak-1-test",
        "main",
        expect.objectContaining({ deferWorkingTreeSync: true, autoResolveAppendConflicts: true }),
      );
      // #970: the merge result resolves early, but the lock is intentionally
      // held until the deferred post-merge cleanup settles — await release.
      await activeMerges.get("/tmp/test-repo")?.promise;
      expect(activeMerges.has("/tmp/test-repo")).toBe(false);
    });

    it("holds the repo merge lock until the deferred post-merge cleanup completes (#970)", { timeout: 30000 }, async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const wsId = await seedWorkspaceForMerge(projectId, issueId);
      let releaseCleanup!: () => void;
      const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
      const gitService = createFakeGitService({
        // removeWorktree runs only in the deferred post-merge cleanup — gate it
        // so the cleanup stays in flight while we probe the lock.
        removeWorktree: vi.fn(async () => { await cleanupGate; }),
      });
      const service = createWorkspaceService({
        database: db,
        gitService,
        createBackup: vi.fn(async () => ({})),
        processKiller: vi.fn(async () => 0),
      });

      const result = await service.mergeWorkspace(wsId);
      expect(result.id).toBe(wsId);

      // The HTTP-facing result resolved, but the deferred cleanup (which applies
      // the git reset --hard sync of the MAIN checkout) has not finished: the
      // repo lock must still be held so a second merge cannot acquire it and
      // observe the main checkout mid-cleanup (#970).
      const lock = activeMerges.get("/tmp/test-repo");
      expect(lock?.workspaceId).toBe(wsId);

      // A second merge for a different workspace is refused, not admitted.
      const otherWsId = await seedWorkspaceForMerge(projectId, issueId);
      await expect(service.mergeWorkspace(otherWsId)).rejects.toMatchObject({ code: "CONFLICT" });

      releaseCleanup();
      await lock!.promise;
      expect(activeMerges.has("/tmp/test-repo")).toBe(false);
    });

  });

  describe("dropped-merge-response reconciliation", () => {
    // These tests cover the scenario described in AK-332: the git plumbing merge
    // completes and mergedAt is written to DB, but the HTTP response is dropped
    // before returning to the client. The issue remains in "In Review". A retry
    // of the merge endpoint must reconcile without requiring manual intervention.

    it("moves the issue from In Review to Done when mergedAt is already set (dropped-response reconciliation)", { timeout: 30000 }, async () => {
      const { issueId } = await seedProjectAndIssueInReview(db);
      const now = new Date().toISOString();
      const wsId = randomUUID();
      const mergedAt = new Date(Date.now() - 5_000).toISOString();

      // mergedAt is set (the merge landed in git + DB) but issue is still In Review
      // because the response dropped before returning.
      await db.insert(workspaces).values({
        id: wsId,
        issueId,
        branch: "feature/ak-1-reconcile",
        workingDir: null,
        baseBranch: "main",
        isDirect: false,
        status: "closed",
        provider: "claude",
        mergedAt,
        createdAt: now,
        updatedAt: now,
      });

      const gitService = createFakeGitService({
        deleteBranch: vi.fn(async () => {}),
        // mergedAt is set but the branch ref is gone (merged + cleaned up) — honor the flag.
        checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: false, branchSha: null, reason: "branch-not-found" })),
      });

      const service = createWorkspaceService({
        database: db,
        gitService,
        createBackup: vi.fn(async () => ({})),
        processKiller: vi.fn(async () => 0),
      });

      const result = await service.mergeWorkspace(wsId);

      expect(result.mergeOutput).toContain("already marked as merged");
      expect(gitService.mergeBranch).not.toHaveBeenCalled();

      // Issue must be moved out of In Review to Done
      const issueRow = await db.select().from(issues).where(eq(issues.id, issueId));
      const statusRow = await db.select().from(projectStatuses).where(eq(projectStatuses.id, issueRow[0].statusId));
      expect(statusRow[0].name).toBe("Done");

      // Workspace must be fully closed
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
      expect(wsRows[0].status).toBe("closed");
      expect(wsRows[0].mergedAt).toBe(mergedAt);
      expect(wsRows[0].closedAt).toBeTruthy();

      // Reconciliation is recorded in the audit trail
      const events = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      const alreadyMergedEvent = events.find((e) => JSON.parse(e.payload ?? "{}").eventType === "already-merged");
      expect(alreadyMergedEvent).toBeDefined();
      expect(alreadyMergedEvent?.body).toContain("Reconciled");
    });

    it("moves issue from In Review to Done when git reports branch already merged (no mergedAt in DB yet)", { timeout: 30000 }, async () => {
      // Scenario: git merge completed, master advanced, but the DB update was dropped.
      // mergedAt is null, issue is in In Review. git's mergeBranch returns "already merged".
      const { issueId } = await seedProjectAndIssueInReview(db);
      const now = new Date().toISOString();
      const wsId = randomUUID();

      await db.insert(workspaces).values({
        id: wsId,
        issueId,
        branch: "feature/ak-1-already-on-master",
        workingDir: "/tmp/test-repo/.worktrees/feature-1",
        baseBranch: "main",
        isDirect: false,
        status: "active",
        readyForMerge: true,
        provider: "claude",
        createdAt: now,
        updatedAt: now,
      });

      const gitService = createFakeGitService({
        mergeBranch: vi.fn(async () => "Branch 'feature/ak-1-already-on-master' is already merged into main (plumbing-merge: abc123)"),
      });

      const service = createWorkspaceService({
        database: db,
        gitService,
        createBackup: vi.fn(async () => ({})),
        processKiller: vi.fn(async () => 0),
      });

      const result = await service.mergeWorkspace(wsId);

      expect(result.mergeOutput).toContain("already merged");

      // Issue must leave In Review
      const issueRow = await db.select().from(issues).where(eq(issues.id, issueId));
      const statusRow = await db.select().from(projectStatuses).where(eq(projectStatuses.id, issueRow[0].statusId));
      expect(statusRow[0].name).toBe("Done");

      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
      expect(wsRows[0].status).toBe("closed");
      expect(wsRows[0].mergedAt).toBeTruthy();
    });

    it("preserves real conflict detection — conflicts still throw 409, not silently reconciled", { timeout: 30000 }, async () => {
      // Regression guard: the reconciliation path must not swallow genuine conflicts.
      const { issueId } = await seedProjectAndIssueInReview(db);
      const now = new Date().toISOString();
      const wsId = randomUUID();

      await db.insert(workspaces).values({
        id: wsId,
        issueId,
        branch: "feature/ak-1-with-conflicts",
        workingDir: "/tmp/test-repo/.worktrees/feature-1",
        baseBranch: "main",
        isDirect: false,
        status: "active",
        readyForMerge: true,
        provider: "claude",
        createdAt: now,
        updatedAt: now,
      });

      const gitService = createFakeGitService({
        detectConflicts: vi.fn(async () => ({
          hasConflicts: true,
          conflictingFiles: ["src/index.ts", "src/routes.ts"],
        })),
      });

      const service = createWorkspaceService({ database: db, gitService, processKiller: vi.fn(async () => 0) });

      await expect(service.mergeWorkspace(wsId)).rejects.toMatchObject({
        code: "CONFLICT",
        data: { conflictFiles: ["src/index.ts", "src/routes.ts"] },
      });

      // Issue must still be in In Review — not silently moved to Done
      const issueRow = await db.select().from(issues).where(eq(issues.id, issueId));
      const statusRow = await db.select().from(projectStatuses).where(eq(projectStatuses.id, issueRow[0].statusId));
      expect(statusRow[0].name).toBe("In Review");

      // Workspace stays active
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
      expect(wsRows[0].status).toBe("active");

      // Conflict recorded in audit trail
      const events = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(events).toEqual([
        expect.objectContaining({
          kind: "merge-attempt",
          body: expect.stringContaining("Merge attempt blocked by conflicts"),
        }),
      ]);
    });

    it("broadcasts workspace_merged when reconciling a dropped response", { timeout: 30000 }, async () => {
      const { issueId } = await seedProjectAndIssueInReview(db);
      const now = new Date().toISOString();
      const wsId = randomUUID();
      const mergedAt = new Date(Date.now() - 3_000).toISOString();

      await db.insert(workspaces).values({
        id: wsId,
        issueId,
        branch: "feature/ak-1-broadcast",
        workingDir: null,
        baseBranch: "main",
        isDirect: false,
        status: "closed",
        provider: "claude",
        mergedAt,
        createdAt: now,
        updatedAt: now,
      });

      const broadcastSpy = vi.fn();
      const boardEvents = { broadcast: broadcastSpy };

      const service = createWorkspaceService({
        database: db,
        gitService: createFakeGitService({
          deleteBranch: vi.fn(async () => {}),
          checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: false, branchSha: null, reason: "branch-not-found" })),
        }),
        boardEvents: boardEvents as never,
        createBackup: vi.fn(async () => ({})),
        processKiller: vi.fn(async () => 0),
      });

      await service.mergeWorkspace(wsId);

      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.any(String),
        "workspace_merged",
      );
    });
  });

  describe("updateBase with HEAD guard", () => {
    async function seedWorkspaceForUpdateBase(projectId: string, issueId: string): Promise<string> {
      const now = new Date().toISOString();
      const id = randomUUID();
      await db.insert(workspaces).values({
        id,
        issueId,
        branch: "feature/ak-1-test",
        workingDir: "/tmp/test-repo/.worktrees/feature-1",
        baseBranch: "main",
        isDirect: false,
        status: "active",
        readyForMerge: true,
        provider: "claude",
        createdAt: now,
        updatedAt: now,
      });
      return id;
    }

    it("refuses to update base when main checkout HEAD is on wrong branch", async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const wsId = await seedWorkspaceForUpdateBase(projectId, issueId);
      const gitService = createFakeGitService({
        getCurrentBranch: vi.fn(async () => "feature/some-other-thing"),
      });

      const service = createWorkspaceService({ database: db, gitService });

      await expect(service.updateBase(wsId, "rebase")).rejects.toMatchObject({
        code: "CONFLICT",
        data: { currentBranch: "feature/some-other-thing", targetBranch: "main" },
      });
    });

    it("proceeds with update-base when HEAD is on the correct branch", async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const wsId = await seedWorkspaceForUpdateBase(projectId, issueId);
      const gitService = createFakeGitService({
        getCurrentBranch: vi.fn(async () => "main"),
        rebaseOntoBase: vi.fn(async () => ({ success: true })),
      });

      const service = createWorkspaceService({ database: db, gitService });
      const result = await service.updateBase(wsId, "rebase");

      expect(result.success).toBe(true);
      expect(gitService.rebaseOntoBase).toHaveBeenCalled();
    });
  });

  describe("fixAndMerge with HEAD guard", () => {
    async function seedWorkspaceForFix(projectId: string, issueId: string): Promise<string> {
      const now = new Date().toISOString();
      const id = randomUUID();
      await db.insert(workspaces).values({
        id,
        issueId,
        branch: "feature/ak-1-test",
        workingDir: "/tmp/test-repo/.worktrees/feature-1",
        baseBranch: "main",
        isDirect: false,
        status: "active",
        readyForMerge: true,
        provider: "claude",
        createdAt: now,
        updatedAt: now,
      });
      return id;
    }

    it("refuses fix-and-merge when main checkout HEAD is on wrong branch", async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const wsId = await seedWorkspaceForFix(projectId, issueId);
      const gitService = createFakeGitService({
        getCurrentBranch: vi.fn(async () => "feature/some-other-thing"),
      });
      const sessionManager = createMockSessionManager();

      const service = createWorkspaceService({ database: db, gitService, getSessionManager: () => sessionManager });

      await expect(service.fixAndMerge(wsId)).rejects.toMatchObject({
        code: "CONFLICT",
        data: { currentBranch: "feature/some-other-thing", targetBranch: "main" },
      });
      expect(sessionManager.startSession).not.toHaveBeenCalled();
    });

    it("syncs and rebases the branch before launching fix-and-merge", async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const wsId = await seedWorkspaceForFix(projectId, issueId);
      const gitService = createFakeGitService({
        syncBranchToHead: vi.fn(async () => true),
        rebaseOntoBase: vi.fn(async () => ({ success: true })),
      });
      const sessionManager = createMockSessionManager();

      const service = createWorkspaceService({ database: db, gitService, getSessionManager: () => sessionManager });
      await service.fixAndMerge(wsId, "Merge conflicts detected");

      expect(gitService.syncBranchToHead).toHaveBeenCalledWith(
        "/tmp/test-repo/.worktrees/feature-1",
        "feature/ak-1-test",
      );
      expect(gitService.rebaseOntoBase).toHaveBeenCalledWith(
        "/tmp/test-repo/.worktrees/feature-1",
        "main",
        "feature/ak-1-test",
        { preferLocalBase: true },
      );
      const startArgs = (sessionManager.startSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(startArgs.prompt).toContain("rebased the workspace branch onto 'main' successfully");
      expect(startArgs.skipLaunchPreflight).toBe(true);

      const events = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(events).toEqual([
        expect.objectContaining({
          kind: "merge-attempt",
          workspaceId: wsId,
          body: expect.stringContaining("Launched a fix-and-merge session"),
        }),
      ]);
      expect(JSON.parse(events[0].payload ?? "{}")).toEqual(expect.objectContaining({
        eventType: "fix-and-merge-launched",
        sessionId: "mock-session-id",
      }));
    });

    it("launches fix-and-merge with rebase conflict context instead of aborting the rebuild", async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const wsId = await seedWorkspaceForFix(projectId, issueId);
      const gitService = createFakeGitService({
        rebaseOntoBase: vi.fn(async () => ({ success: false, conflictingFiles: ["src/foo.ts"], error: "conflict" })),
      });
      const sessionManager = createMockSessionManager();

      const service = createWorkspaceService({ database: db, gitService, getSessionManager: () => sessionManager });
      await service.fixAndMerge(wsId, "Merge conflicts detected");

      expect(gitService.abortRebase).not.toHaveBeenCalled();
      expect(sessionManager.startSession).toHaveBeenCalledOnce();
      const startArgs = (sessionManager.startSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(startArgs.prompt).toContain("left the rebase in progress");
      expect(startArgs.prompt).toContain("src/foo.ts");
      expect(startArgs.skipLaunchPreflight).toBe(true);
    });
  });

  describe("stopWorkspace with blocked fix-and-merge session", () => {
    it("stops the running session and clears readyForMerge so relaunch does not re-trigger merge", async () => {
      const { issueId } = await seedProjectAndIssue(db);
      const now = new Date().toISOString();
      const wsId = randomUUID();
      const sessionId = randomUUID();

      await db.insert(workspaces).values({
        id: wsId,
        issueId,
        branch: "feature/ak-1-test",
        workingDir: "/tmp/test-repo/.worktrees/feature-1",
        baseBranch: "main",
        isDirect: false,
        status: "fixing",
        readyForMerge: true,
        provider: "claude",
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(sessions).values({
        id: sessionId,
        workspaceId: wsId,
        status: "running",
        triggerType: "fix-and-merge",
        startedAt: now,
        executor: "claude-code",
      });

      const sessionManager = createMockSessionManager();
      const service = createWorkspaceService({ database: db, getSessionManager: () => sessionManager });

      const result = await service.stopWorkspace(wsId);
      expect(result).toEqual({ stopped: true });

      expect(sessionManager.stopSession).toHaveBeenCalledOnce();
      expect(sessionManager.stopSession).toHaveBeenCalledWith(sessionId);

      const [updated] = await db.select({
        status: workspaces.status,
        readyForMerge: workspaces.readyForMerge,
      }).from(workspaces).where(eq(workspaces.id, wsId));
      expect(updated).toEqual({
        status: "idle",
        readyForMerge: false,
      });
    });
  });

  describe("sendTurn with auto_rebase_on_continue", () => {
    async function seedWorkspaceWithSession(projectId: string, issueId: string): Promise<{ wsId: string; sessionId: string }> {
      const now = new Date().toISOString();
      const wsId = randomUUID();
      const sessionId = randomUUID();
      await db.insert(workspaces).values({
        id: wsId,
        issueId,
        branch: "feature/ak-1-test",
        workingDir: "/tmp/test-repo/.worktrees/feature-1",
        baseBranch: "main",
        isDirect: false,
        status: "idle",
        provider: "claude",
        createdAt: now,
        updatedAt: now,
      });
      // Seed a completed session so sendTurn finds a resumable session
      const { sessions: sessionsTable } = await import("@agentic-kanban/shared/schema");
      await db.insert(sessionsTable).values({
        id: sessionId,
        workspaceId: wsId,
        status: "completed",
        triggerType: "chat",
        startedAt: now,
        endedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { wsId, sessionId };
    }

    it("auto-rebases before starting agent when auto_rebase_on_continue is true", async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const { wsId } = await seedWorkspaceWithSession(projectId, issueId);

      // Enable the preference
      const now = new Date().toISOString();
      await db.insert(preferences).values({ key: "auto_rebase_on_continue", value: "true", updatedAt: now })
        .onConflictDoUpdate({ target: preferences.key, set: { value: "true", updatedAt: now } });

      const gitService = createFakeGitService({
        rebaseOntoBase: vi.fn(async () => ({ success: true })),
      });
      const sessionManager = createMockSessionManager();
      const service = createWorkspaceService({ database: db, gitService, getSessionManager: () => sessionManager });

      await service.sendTurn(wsId, "continue with the task");

      expect(gitService.rebaseOntoBase).toHaveBeenCalledWith(
        "/tmp/test-repo/.worktrees/feature-1",
        "main",
        "feature/ak-1-test",
      );
      expect(sessionManager.startSession).toHaveBeenCalledOnce();
    });

    it("skips auto-rebase when auto_rebase_on_continue is false (default)", async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const { wsId } = await seedWorkspaceWithSession(projectId, issueId);

      const gitService = createFakeGitService();
      const sessionManager = createMockSessionManager();
      const service = createWorkspaceService({ database: db, gitService, getSessionManager: () => sessionManager });

      await service.sendTurn(wsId, "continue with the task");

      expect(gitService.rebaseOntoBase).not.toHaveBeenCalled();
      expect(sessionManager.startSession).toHaveBeenCalledOnce();
    });

    it("throws CONFLICT and aborts rebase when auto-rebase finds conflicts", async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const { wsId } = await seedWorkspaceWithSession(projectId, issueId);

      const now = new Date().toISOString();
      await db.insert(preferences).values({ key: "auto_rebase_on_continue", value: "true", updatedAt: now })
        .onConflictDoUpdate({ target: preferences.key, set: { value: "true", updatedAt: now } });

      const gitService = createFakeGitService({
        rebaseOntoBase: vi.fn(async () => ({ success: false, conflictingFiles: ["src/foo.ts"], error: "conflict" })),
      });
      const sessionManager = createMockSessionManager();
      const service = createWorkspaceService({ database: db, gitService, getSessionManager: () => sessionManager });

      await expect(service.sendTurn(wsId, "continue")).rejects.toMatchObject({
        code: "CONFLICT",
        data: { conflictingFiles: ["src/foo.ts"] },
      });

      // Abort should have been called to restore clean state
      expect(gitService.abortRebase).toHaveBeenCalledWith("/tmp/test-repo/.worktrees/feature-1");
      // Agent should NOT have been started
      expect(sessionManager.startSession).not.toHaveBeenCalled();
    });

    it("skips auto-rebase for direct workspaces even when pref is true", async () => {
      const now = new Date().toISOString();
      const { issueId } = await seedProjectAndIssue(db);
      const wsId = randomUUID();
      const sessionId = randomUUID();
      await db.insert(workspaces).values({
        id: wsId,
        issueId,
        branch: "feature/ak-1-test",
        workingDir: "/tmp/test-repo/.worktrees/feature-1",
        baseBranch: "main",
        isDirect: true, // direct workspace
        status: "idle",
        provider: "claude",
        createdAt: now,
        updatedAt: now,
      });
      const { sessions: sessionsTable } = await import("@agentic-kanban/shared/schema");
      await db.insert(sessionsTable).values({
        id: sessionId,
        workspaceId: wsId,
        status: "completed",
        triggerType: "chat",
        startedAt: now,
        endedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(preferences).values({ key: "auto_rebase_on_continue", value: "true", updatedAt: now })
        .onConflictDoUpdate({ target: preferences.key, set: { value: "true", updatedAt: now } });

      const gitService = createFakeGitService();
      const sessionManager = createMockSessionManager();
      const service = createWorkspaceService({ database: db, gitService, getSessionManager: () => sessionManager });

      await service.sendTurn(wsId, "continue");

      expect(gitService.rebaseOntoBase).not.toHaveBeenCalled();
    });
  });
});

describe("getWorkspaceDetails — live session fields", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  async function seedWorkspace(testDb: TestDb): Promise<{ wsId: string; issueId: string }> {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const wsId = randomUUID();

    await testDb.insert(projects).values({
      id: projectId,
      name: "Test Project",
      repoPath: "/tmp/repo",
      repoName: "repo",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });

    const statusId = randomUUID();
    await testDb.insert(projectStatuses).values({
      id: statusId,
      projectId,
      name: "Todo",
      sortOrder: 0,
      isDefault: true,
      createdAt: now,
    });

    await testDb.insert(issues).values({
      id: issueId,
      issueNumber: 1,
      title: "Test issue",
      description: "",
      priority: "medium",
      sortOrder: 0,
      statusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });

    await testDb.insert(workspaces).values({
      id: wsId,
      issueId,
      branch: "feature/ak-1-test",
      workingDir: "/tmp/repo/.worktrees/feature-1",
      baseBranch: "main",
      isDirect: false,
      status: "active",
      provider: "claude",
      createdAt: now,
      updatedAt: now,
    });

    return { wsId, issueId };
  }

  it("returns null session fields when no session exists", async () => {
    const { wsId } = await seedWorkspace(db);
    const details = await getWorkspaceDetails(wsId, db);
    expect(details).not.toBeNull();
    expect(details!.sessionStatus).toBeNull();
    expect(details!.lastSessionAt).toBeNull();
    expect(details!.lastSessionTriggerType).toBeNull();
    expect(details!.contextTokens).toBeNull();
    expect(details!.lastTool).toBeNull();
  });

  it("exposes sessionStatus and lastSessionAt from the latest running session", async () => {
    const { wsId } = await seedWorkspace(db);
    const startedAt = new Date(Date.now() - 5000).toISOString();
    await db.insert(sessions).values({
      id: randomUUID(),
      workspaceId: wsId,
      status: "running",
      triggerType: "initial",
      startedAt,
      executor: "claude-code",
    });

    const details = await getWorkspaceDetails(wsId, db);
    expect(details!.sessionStatus).toBe("running");
    expect(details!.lastSessionAt).toBe(startedAt);
    expect(details!.lastSessionTriggerType).toBe("initial");
  });

  it("exposes endedAt as lastSessionAt for a completed session", async () => {
    const { wsId } = await seedWorkspace(db);
    const endedAt = new Date(Date.now() - 1000).toISOString();
    await db.insert(sessions).values({
      id: randomUUID(),
      workspaceId: wsId,
      status: "completed",
      triggerType: "chat",
      startedAt: new Date(Date.now() - 10000).toISOString(),
      endedAt,
      executor: "claude-code",
    });

    const details = await getWorkspaceDetails(wsId, db);
    expect(details!.sessionStatus).toBe("completed");
    expect(details!.lastSessionAt).toBe(endedAt);
  });

  it("picks the latest session when multiple exist and populates contextTokens/lastTool from stats", async () => {
    const { wsId } = await seedWorkspace(db);
    const older = new Date(Date.now() - 20000).toISOString();
    const newer = new Date(Date.now() - 2000).toISOString();
    const newerEnd = new Date(Date.now() - 1000).toISOString();

    await db.insert(sessions).values({
      id: randomUUID(),
      workspaceId: wsId,
      status: "completed",
      triggerType: "initial",
      startedAt: older,
      endedAt: older,
      executor: "claude-code",
      stats: JSON.stringify({ contextTokens: 100, lastTool: "old-tool" }),
    });

    await db.insert(sessions).values({
      id: randomUUID(),
      workspaceId: wsId,
      status: "completed",
      triggerType: "chat",
      startedAt: newer,
      endedAt: newerEnd,
      executor: "claude-code",
      stats: JSON.stringify({ contextTokens: 42000, lastTool: "Write" }),
    });

    const details = await getWorkspaceDetails(wsId, db);
    expect(details!.sessionStatus).toBe("completed");
    expect(details!.lastSessionTriggerType).toBe("chat");
    expect(details!.contextTokens).toBe(42000);
    expect(details!.lastTool).toBe("Write");
  });
});

/**
 * The deferred provision+launch chain around per-workspace service stacks. The compose
 * engine singleton is spied so no docker/fs is touched; what is under test is the
 * ORCHESTRATION: fail-loud composeRepo resolution, the delete/close-during-provisioning
 * race (0-row persist → teardown, no launch), the pre-launch lifecycle re-check, and
 * the stack-FAILED ticket-context note.
 */
describe("createWorkspace — service stack deferred chain", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const SERVICES_CONFIG = JSON.stringify({ enabled: true, composeFile: "docker-compose.yml", ports: ["db"] });

  async function seedServicesProject(servicesConfig: string): Promise<{ projectId: string; issueId: string }> {
    const seeded = await seedProjectAndIssue(db);
    await db.update(projects).set({ servicesConfig }).where(eq(projects.id, seeded.projectId));
    return seeded;
  }

  function makeService(gitService = createFakeGitService()) {
    const sessionManager = createMockSessionManager();
    const service = createWorkspaceService({
      database: db,
      getSessionManager: () => sessionManager,
      gitService,
    });
    return { service, sessionManager };
  }

  function upState(worktree: string): { composeProjectName: string; ports: Record<string, number>; envFilePath: string; status: "up"; updatedAt: string } {
    return {
      composeProjectName: "ak-testinst-ws-abc123def456",
      ports: { db: 61000 },
      envFilePath: join(worktree, ".kanban", "services.env"),
      status: "up",
      updatedAt: new Date().toISOString(),
    };
  }

  it("fails LOUDLY when composeRepo doesn't resolve: persists an error state, never provisions a fallback stack (#15)", async () => {
    const { issueId } = await seedServicesProject(JSON.stringify({ enabled: true, composeRepo: "infra" }));
    const provisionSpy = vi
      .spyOn(workspaceServicesService, "provisionWorkspaceServices")
      .mockResolvedValue(upState("/nowhere"));
    const { service, sessionManager } = makeService();

    const result = await service.createWorkspace({ issueId, branch: "feature/ak-1-badrepo" });
    expect(result.error).toBeUndefined();
    await flushDeferred();

    // The engine was NEVER invoked — no unrelated compose file was brought up.
    expect(provisionSpy).not.toHaveBeenCalled();

    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, result.id));
    const state = JSON.parse(wsRows[0].serviceState!) as { status: string; error?: string };
    expect(state.status).toBe("error");
    expect(state.error).toContain("composeRepo 'infra'");

    // The workspace itself still lives and the agent still launches (non-fatal error).
    expect(sessionManager.startSession).toHaveBeenCalledOnce();
  });

  it("tears the stack down and skips the launch when the workspace is DELETED during provisioning (#11)", async () => {
    const { issueId } = await seedServicesProject(SERVICES_CONFIG);
    const teardownSpy = vi
      .spyOn(workspaceServicesService, "teardownWorkspaceServices")
      .mockResolvedValue(undefined);
    // Deterministic race: the delete happens INSIDE the (mocked) provisioning window.
    const provisionSpy = vi
      .spyOn(workspaceServicesService, "provisionWorkspaceServices")
      .mockImplementation(async (args) => {
        await db.delete(workspaces).where(eq(workspaces.id, args.workspaceId));
        return upState("/tmp/test-repo/.worktrees/feature-1");
      });
    const { service, sessionManager } = makeService();

    const result = await service.createWorkspace({ issueId, branch: "feature/ak-1-deleted" });
    expect(result.error).toBeUndefined();
    await flushDeferred();

    expect(provisionSpy).toHaveBeenCalledOnce();
    // The freshly-started stack was downed (0-row persist → convergent teardown) …
    expect(teardownSpy).toHaveBeenCalledOnce();
    expect(teardownSpy).toHaveBeenCalledWith(
      expect.objectContaining({ composeProjectName: "ak-testinst-ws-abc123def456" }),
    );
    // … and no agent was launched into the removed workspace.
    expect(sessionManager.startSession).not.toHaveBeenCalled();
  });

  it("tears the stack down and skips the launch when the workspace is CLOSED during provisioning (#11 close variant)", async () => {
    const { issueId } = await seedServicesProject(SERVICES_CONFIG);
    const teardownSpy = vi
      .spyOn(workspaceServicesService, "teardownWorkspaceServices")
      .mockResolvedValue(undefined);
    vi.spyOn(workspaceServicesService, "provisionWorkspaceServices").mockImplementation(async (args) => {
      await db
        .update(workspaces)
        .set({ status: "closed", closedAt: new Date().toISOString() })
        .where(eq(workspaces.id, args.workspaceId));
      return upState("/tmp/test-repo/.worktrees/feature-1");
    });
    const { service, sessionManager } = makeService();

    const result = await service.createWorkspace({ issueId, branch: "feature/ak-1-closed" });
    expect(result.error).toBeUndefined();
    await flushDeferred();

    expect(teardownSpy).toHaveBeenCalledOnce();
    expect(sessionManager.startSession).not.toHaveBeenCalled();
    // The closed row's state was NOT clobbered by the late persist.
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, result.id));
    expect(wsRows[0].serviceState).toBeNull();
  });

  it("skips the deferred agent launch when the workspace vanished even WITHOUT a stack (pre-launch re-check)", async () => {
    const { issueId } = await seedServicesProject(SERVICES_CONFIG);
    const teardownSpy = vi
      .spyOn(workspaceServicesService, "teardownWorkspaceServices")
      .mockResolvedValue(undefined);
    // Provisioning reports "no stack" (null) but the workspace is deleted meanwhile.
    vi.spyOn(workspaceServicesService, "provisionWorkspaceServices").mockImplementation(async (args) => {
      await db.delete(workspaces).where(eq(workspaces.id, args.workspaceId));
      return null as never;
    });
    const { service, sessionManager } = makeService();

    const result = await service.createWorkspace({ issueId, branch: "feature/ak-1-gone" });
    expect(result.error).toBeUndefined();
    await flushDeferred();

    expect(sessionManager.startSession).not.toHaveBeenCalled();
    expect(teardownSpy).not.toHaveBeenCalled(); // nothing came up, nothing to down
  });

  it("ADOPTS a live co-resident's stack on a shared worktree: no second provision, services.env untouched (finding 12)", async () => {
    const worktreeDir = await mkdtemp(join(tmpdir(), "ak-ws-shared-"));
    try {
      const { issueId } = await seedServicesProject(SERVICES_CONFIG);
      const donorId = randomUUID();
      const donorState = {
        composeProjectName: "ak-testinst-ws-donor0000001",
        ports: { db: 61234 },
        envFilePath: join(worktreeDir, ".kanban", "services.env"),
        status: "up",
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      };
      // Live co-resident (the donor) already on this worktree with its stack up.
      await db.insert(workspaces).values({
        id: donorId,
        issueId,
        branch: "feature/ak-1-shared",
        status: "active",
        workingDir: worktreeDir,
        serviceState: JSON.stringify(donorState),
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      });
      // The donor's generated env file — must never be rewritten by the second create.
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(worktreeDir, ".kanban"), { recursive: true });
      await writeFile(join(worktreeDir, ".kanban", "services.env"), "SENTINEL='donor'\n", "utf-8");

      const provisionSpy = vi
        .spyOn(workspaceServicesService, "provisionWorkspaceServices")
        .mockResolvedValue(upState(worktreeDir));
      const gitService = createFakeGitService({ createWorktree: vi.fn(async () => worktreeDir) });
      const { service, sessionManager } = makeService(gitService);

      const result = await service.createWorkspace({ issueId, branch: "feature/ak-1-shared" });
      expect(result.error).toBeUndefined();
      await flushDeferred();
      // The agent launch is the LAST deferred step — once it ran, the whole chain ran.
      await vi.waitFor(() => expect(sessionManager.startSession).toHaveBeenCalledOnce());

      // No second stack was brought up …
      expect(provisionSpy).not.toHaveBeenCalled();
      // … the donor's env file is byte-identical …
      const env = await readFile(join(worktreeDir, ".kanban", "services.env"), "utf-8");
      expect(env).toBe("SENTINEL='donor'\n");
      // … and the new workspace RECORDS the donor's compose project (adoption).
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, result.id));
      const state = JSON.parse(wsRows[0].serviceState!) as { composeProjectName: string; status: string; ports: Record<string, number> };
      expect(state.composeProjectName).toBe(donorState.composeProjectName);
      expect(state.status).toBe("up");
      expect(state.ports).toEqual({ db: 61234 });
    } finally {
      await rm(worktreeDir, { recursive: true, force: true });
    }
  });

  it("REFUSES to provision on a shared worktree when the senior co-resident has no adoptable stack yet", async () => {
    const worktreeDir = await mkdtemp(join(tmpdir(), "ak-ws-shared-pend-"));
    try {
      const { issueId } = await seedServicesProject(SERVICES_CONFIG);
      const seniorId = randomUUID();
      // Senior co-resident whose own provisioning hasn't persisted a state yet
      // (e.g. still inside its `up --wait` window).
      await db.insert(workspaces).values({
        id: seniorId,
        issueId,
        branch: "feature/ak-1-pending",
        status: "active",
        workingDir: worktreeDir,
        serviceState: null,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      });
      const provisionSpy = vi
        .spyOn(workspaceServicesService, "provisionWorkspaceServices")
        .mockResolvedValue(upState(worktreeDir));
      const gitService = createFakeGitService({ createWorktree: vi.fn(async () => worktreeDir) });
      const { service, sessionManager } = makeService(gitService);

      const result = await service.createWorkspace({ issueId, branch: "feature/ak-1-pending" });
      expect(result.error).toBeUndefined();
      await flushDeferred();
      // Refusal is non-fatal, like every other stack error: the agent still launches.
      // The launch is the LAST deferred step — once it ran, the whole chain ran.
      await vi.waitFor(() => expect(sessionManager.startSession).toHaveBeenCalledOnce());

      // Never raced the senior sharer for .kanban/services.env.
      expect(provisionSpy).not.toHaveBeenCalled();
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, result.id));
      const state = JSON.parse(wsRows[0].serviceState!) as { composeProjectName: string; status: string; error?: string };
      expect(state.status).toBe("error");
      expect(state.composeProjectName).toBe("");
      expect(state.error).toContain(seniorId);
    } finally {
      await rm(worktreeDir, { recursive: true, force: true });
    }
  });

  it("delete runs the stack teardown UNCONDITIONALLY (with releaser id) even while the worktree is shared", async () => {
    const { issueId } = await seedServicesProject(SERVICES_CONFIG);
    const sharedDir = "/tmp/test-repo/.worktrees/feature-del-shared";
    const stack = "ak-testinst-ws-shared000001";
    const stateJson = JSON.stringify({
      composeProjectName: stack,
      ports: { db: 61000 },
      envFilePath: join(sharedDir, ".kanban", "services.env"),
      status: "up",
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const keeperId = randomUUID();
    const goingId = randomUUID();
    for (const [id, offset] of [[keeperId, 120_000], [goingId, 60_000]] as const) {
      await db.insert(workspaces).values({
        id,
        issueId,
        branch: "feature/ak-1-del-shared",
        status: "active",
        workingDir: sharedDir,
        serviceState: stateJson,
        createdAt: new Date(Date.now() - offset).toISOString(),
        updatedAt: new Date(Date.now() - offset).toISOString(),
      });
    }
    const teardownSpy = vi
      .spyOn(workspaceServicesService, "teardownWorkspaceServices")
      .mockResolvedValue(undefined);
    const gitService = createFakeGitService();
    const { service } = makeService(gitService);

    await service.deleteWorkspace(goingId);

    // The per-workspace teardown was NOT skipped behind the shared-worktree gate; the
    // engine's last-reference guard (given the releaser id) decides whether to down.
    expect(teardownSpy).toHaveBeenCalledOnce();
    expect(teardownSpy).toHaveBeenCalledWith(
      expect.objectContaining({ composeProjectName: stack, releasedByWorkspaceId: goingId }),
    );
    // The shared worktree itself stays (the keeper still points at it).
    expect(gitService.removeWorktree).not.toHaveBeenCalled();
    // The keeper row survives untouched.
    const keeperRows = await db.select().from(workspaces).where(eq(workspaces.id, keeperId));
    expect(keeperRows).toHaveLength(1);
  });

  it("close passes the releaser id to the stack teardown", async () => {
    const { issueId } = await seedServicesProject(SERVICES_CONFIG);
    const wsId = randomUUID();
    const stack = "ak-testinst-ws-close0000001";
    await db.insert(workspaces).values({
      id: wsId,
      issueId,
      branch: "feature/ak-1-close",
      status: "active",
      workingDir: "/tmp/test-repo/.worktrees/feature-close",
      serviceState: JSON.stringify({
        composeProjectName: stack,
        ports: {},
        envFilePath: "/tmp/test-repo/.worktrees/feature-close/.kanban/services.env",
        status: "up",
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const teardownSpy = vi
      .spyOn(workspaceServicesService, "teardownWorkspaceServices")
      .mockResolvedValue(undefined);
    const { service } = makeService();

    await service.closeWorkspace(wsId);

    expect(teardownSpy).toHaveBeenCalledOnce();
    expect(teardownSpy).toHaveBeenCalledWith(
      expect.objectContaining({ composeProjectName: stack, releasedByWorkspaceId: wsId }),
    );
  });

  it("rewrites the ticket-context with an explicit stack-FAILED note when the stack errors (#20)", async () => {
    const worktreeDir = await mkdtemp(join(tmpdir(), "ak-ws-svcerr-"));
    try {
      const { issueId } = await seedServicesProject(SERVICES_CONFIG);
      vi.spyOn(workspaceServicesService, "provisionWorkspaceServices").mockResolvedValue({
        composeProjectName: "ak-testinst-ws-abc123def456",
        ports: {},
        envFilePath: join(worktreeDir, ".kanban", "services.env"),
        status: "error",
        error: "image xyz not found",
        updatedAt: new Date().toISOString(),
      });
      const gitService = createFakeGitService({ createWorktree: vi.fn(async () => worktreeDir) });
      const { service, sessionManager } = makeService(gitService);

      const result = await service.createWorkspace({ issueId, branch: "feature/ak-1-stackerr" });
      expect(result.error).toBeUndefined();
      await flushDeferred();

      // The agent's context file states the services are NOT available, with the reason.
      const ctx = await readFile(join(worktreeDir, "CLAUDE.local.md"), "utf-8");
      expect(ctx).toContain("FAILED TO START");
      expect(ctx).toContain("image xyz not found");

      // serviceState carries the error, and the agent still launches (non-fatal).
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, result.id));
      const state = JSON.parse(wsRows[0].serviceState!) as { status: string; error?: string };
      expect(state.status).toBe("error");
      expect(state.error).toContain("image xyz not found");
      expect(sessionManager.startSession).toHaveBeenCalledOnce();
    } finally {
      await rm(worktreeDir, { recursive: true, force: true });
    }
  });
});
