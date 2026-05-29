import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { projects, projectStatuses, issues, workspaces, preferences } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import { createWorkspaceService, WorkspaceError, type GitService } from "../services/workspace.service.js";

// Mock process-cleanup so killWorktreeProcesses doesn't run real wmic/lsof in unit tests.
vi.mock("../services/process-cleanup.js", () => ({
  killProcessesInDir: vi.fn(async () => 0),
}));

/**
 * Unit tests for workspace.service using an in-memory SQLite DB plus an injected
 * fake git service and session manager. No real git, no subprocesses, no E2E.
 */

/** Seed a project (with Todo/In Progress/Done statuses) and one issue. */
async function seedProjectAndIssue(db: TestDb): Promise<{ projectId: string; issueId: string }> {
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
    priority: "medium",
    sortOrder: 0,
    statusId: statusIds["Todo"],
    projectId,
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId };
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
    removeWorktree: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    getUncommittedTrackedChanges: vi.fn(async () => []),
    syncBranchToHead: vi.fn(async () => true),
    mergeBranch: vi.fn(async () => "Merge made by the 'ort' strategy."),
    pruneWorktrees: vi.fn(async () => {}),
    rebaseOntoBase: vi.fn(async () => ({ success: true })),
    abortRebase: vi.fn(async () => {}),
    ...overrides,
  } as unknown as GitService;
}

describe("workspace.service", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
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
      expect(result.sessionId).toBe("mock-session-id");

      // Worktree was created off the project default branch
      expect(gitService.createWorktree).toHaveBeenCalledWith("/tmp/test-repo", "feature/ak-1-test", "main");
      // Agent launch happened
      expect(sessionManager.startSession).toHaveBeenCalledOnce();

      // Workspace row persisted
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, result.id));
      expect(wsRows).toHaveLength(1);
      expect(wsRows[0].status).toBe("active");

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

        const ctx = (await readFile(join(worktreeDir, "CLAUDE.local.md"), "utf-8")).trim();
        // Seed issue: number 1, title "Implement feature", description "Do the thing"
        expect(ctx).toContain("# Ticket #1: Implement feature");
        expect(ctx).toContain("Do the thing");
      } finally {
        await rm(worktreeDir, { recursive: true, force: true });
      }
    });

    it("rolls back the worktree and returns an error result when agent spawn fails", async () => {
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

      const result = await service.createWorkspace({ issueId, branch: "feature/ak-1-fail" });

      // Failure is surfaced via the error field, not a thrown exception
      expect(result.error).toBe("spawn ENOENT");
      // Orphaned worktree was cleaned up
      expect(gitService.removeWorktree).toHaveBeenCalledWith("/tmp/test-repo", "/tmp/test-repo/.worktrees/feature-1");
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
        provider: "claude",
        createdAt: now,
        updatedAt: now,
      });
      return id;
    }

    it("merges the branch, cleans up the worktree, closes the workspace, and moves the issue to Done", async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const wsId = await seedWorkspaceForMerge(projectId, issueId);
      const gitService = createFakeGitService();

      const createBackup = vi.fn(async () => ({}));
      const service = createWorkspaceService({ database: db, gitService, createBackup });

      const result = await service.mergeWorkspace(wsId);

      expect(result.id).toBe(wsId);
      expect(result.mergeOutput).toContain("Merge made");
      expect(gitService.mergeBranch).toHaveBeenCalledWith("/tmp/test-repo", "feature/ak-1-test");
      expect(gitService.removeWorktree).toHaveBeenCalled();

      // Workspace closed
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
      expect(wsRows[0].status).toBe("closed");
      expect(wsRows[0].workingDir).toBeNull();

      // Issue moved to Done
      const issueRow = await db.select().from(issues).where(eq(issues.id, issueId));
      const statusRow = await db.select().from(projectStatuses).where(eq(projectStatuses.id, issueRow[0].statusId));
      expect(statusRow[0].name).toBe("Done");
    });

    it("throws a BAD_REQUEST WorkspaceError with the conflicting files when merge conflicts are detected", async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const wsId = await seedWorkspaceForMerge(projectId, issueId);
      const gitService = createFakeGitService({
        detectConflicts: vi.fn(async () => ({ hasConflicts: true, conflictingFiles: ["src/foo.ts"] })),
      });

      const service = createWorkspaceService({ database: db, gitService });

      await expect(service.mergeWorkspace(wsId)).rejects.toMatchObject({
        code: "BAD_REQUEST",
        data: { conflictingFiles: ["src/foo.ts"] },
      });
      expect(gitService.mergeBranch).not.toHaveBeenCalled();

      // Workspace stays active (not closed) on conflict
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
      expect(wsRows[0].status).toBe("active");
    });

    it("refuses to merge when main checkout HEAD is not on the workspace's base branch", async () => {
      const { projectId, issueId } = await seedProjectAndIssue(db);
      const wsId = await seedWorkspaceForMerge(projectId, issueId);
      // Main checkout sits on some unrelated feature branch — merging would silently land there
      const gitService = createFakeGitService({
        getCurrentBranch: vi.fn(async () => "feature/some-other-thing"),
      });

      const service = createWorkspaceService({ database: db, gitService });

      await expect(service.mergeWorkspace(wsId)).rejects.toMatchObject({
        code: "CONFLICT",
        data: { currentBranch: "feature/some-other-thing", targetBranch: "main" },
      });
      expect(gitService.mergeBranch).not.toHaveBeenCalled();

      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
      expect(wsRows[0].status).toBe("active");
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
      const { projectId, issueId } = await seedProjectAndIssue(db);
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
