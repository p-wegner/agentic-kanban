import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { projects, projectStatuses, issues, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import { createWorkspaceService, WorkspaceError, type GitService } from "../services/workspace.service.js";

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

    it("rolls back the DB row and the worktree when agent spawn fails, and throws", async () => {
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

      await expect(service.createWorkspace({ issueId, branch: "feature/ak-1-fail" })).rejects.toThrow("spawn ENOENT");

      // Orphaned worktree was cleaned up
      expect(gitService.removeWorktree).toHaveBeenCalledWith("/tmp/test-repo", "/tmp/test-repo/.worktrees/feature-1");

      // No workspace row must remain in the DB (atomic rollback)
      const wsRows = await db.select().from(workspaces);
      expect(wsRows).toHaveLength(0);
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
});
