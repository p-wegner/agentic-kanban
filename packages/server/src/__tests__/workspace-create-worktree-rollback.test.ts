import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceCrudService } from "../services/workspace-crud.service.js";
import { WorkspaceError } from "../services/workspace-internals.js";
import * as crudRepo from "../repositories/workspace-crud.repository.js";

/**
 * Regression tests for #893: workspace creation is not cross-resource atomic.
 *
 * setupWorktree provisions the real git worktree + branch on disk BEFORE the DB
 * transaction opens. If anything after provisioning fails (DB txn rollback,
 * workflow-init failure, or a WorkspaceError surfaced from agent-config
 * resolution), the worktree directory + branch must be compensated away — else
 * they persist as an orphan with no backing DB row that the board can't see or
 * cascade-clean.
 *
 * These tests assert the compensating worktree removal fires for BOTH failure
 * shapes: a plain Error (returns an error-status record) and a WorkspaceError
 * (re-thrown to the caller) — and that no orphan workspace row survives.
 */

function makeGitService(overrides: Record<string, unknown> = {}) {
  return {
    createWorktree: vi.fn(async (_repo: string, branch: string) => `/tmp/worktrees/${branch}`),
    removeWorktree: vi.fn(async () => {}),
    getCurrentBranch: vi.fn(async () => "main"),
    getHeadCommitSha: vi.fn(async () => "abc123"),
    revParse: vi.fn(async () => "abc123"),
    pruneWorktrees: vi.fn(async () => {}),
    listWorktrees: vi.fn(async () => []),
    ensureOnBranch: vi.fn(async () => {}),
    ...overrides,
  };
}

async function seedIssue(
  db: ReturnType<typeof createTestDb>["db"],
  opts: { withInProgressStatus?: boolean } = {},
) {
  const withInProgressStatus = opts.withInProgressStatus ?? true;
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Test Project",
    repoPath: "/tmp/repo",
    repoName: "repo",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  // The issue still needs a status to satisfy its FK; only the "In Progress"
  // status (the one moveIssueToInProgressStrict looks up inside the txn) is
  // optional so we can force a transaction failure after the worktree exists.
  await db.insert(projectStatuses).values({
    id: statusId,
    projectId,
    name: withInProgressStatus ? "In Progress" : "Backlog",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 1,
    title: "Atomic worktree provisioning",
    description: null,
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId };
}

describe("workspace creation cross-resource atomicity (#893)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes the orphaned worktree when the DB transaction rolls back (plain Error)", async () => {
    // No "In Progress" status → moveIssueToInProgressStrict throws inside the txn,
    // AFTER setupWorktree has already created the worktree on disk.
    const { issueId } = await seedIssue(db, { withInProgressStatus: false });

    const git = makeGitService();
    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => ({
        startSession: vi.fn(async () => "session-id"),
        stopSession: vi.fn(),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
      }) as never,
      gitService: git as never,
    });

    const result = await svc.createWorkspace({
      issueId,
      branch: "feature/ak-1-test",
      isDirect: false,
      skipSetup: true,
      skipContextPacker: true,
    });

    // The worktree was provisioned, then the txn failed.
    expect(git.createWorktree).toHaveBeenCalledTimes(1);
    // Compensation: the orphaned worktree must be removed.
    expect(git.removeWorktree).toHaveBeenCalledTimes(1);
    expect(git.removeWorktree).toHaveBeenCalledWith("/tmp/repo", "/tmp/worktrees/feature/ak-1-test");

    // Failure is surfaced and no orphaned workspace row was committed.
    expect(result.status).toBe("error");
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.issueId, issueId));
    expect(wsRows).toHaveLength(0);
  });

  it("removes the orphaned worktree when a WorkspaceError surfaces inside the txn", async () => {
    const { issueId } = await seedIssue(db);

    // Inject a WorkspaceError from the workspaces insert — i.e. INSIDE the DB
    // transaction, AFTER setupWorktree has already created the worktree on disk.
    // This is the exact shape (#893) that previously re-threw the WorkspaceError
    // without any compensating worktree rollback, stranding an orphan.
    vi.spyOn(crudRepo, "insertWorkspaceRecordRow").mockRejectedValue(
      new WorkspaceError("simulated txn failure", "CONFLICT"),
    );

    const git = makeGitService();
    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => ({
        startSession: vi.fn(async () => "session-id"),
        stopSession: vi.fn(),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
      }) as never,
      gitService: git as never,
    });

    await expect(svc.createWorkspace({
      issueId,
      branch: "feature/ak-1-test",
      isDirect: false,
      skipSetup: true,
      skipContextPacker: true,
    })).rejects.toBeInstanceOf(WorkspaceError);

    // The worktree was provisioned before the failing insert...
    expect(git.createWorktree).toHaveBeenCalledTimes(1);
    // ...and the compensating rollback removed it despite the WorkspaceError.
    expect(git.removeWorktree).toHaveBeenCalledTimes(1);
    expect(git.removeWorktree).toHaveBeenCalledWith("/tmp/repo", "/tmp/worktrees/feature/ak-1-test");

    // No orphaned workspace row survived the rolled-back transaction.
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.issueId, issueId));
    expect(wsRows).toHaveLength(0);
  });

  it("does not attempt worktree removal when a WorkspaceError fires before provisioning", async () => {
    // The open-direct-workspace guard runs BEFORE setupWorktree, so no worktree is
    // created and the rollback must correctly no-op (boundary: pre-provision
    // WorkspaceErrors never create an orphan, so removeWorktree must not fire).
    const { issueId } = await seedIssue(db);
    const now = new Date().toISOString();
    await db.insert(workspaces).values({
      id: "direct-leftover",
      issueId,
      branch: "main",
      workingDir: "/tmp/repo",
      baseBranch: null,
      isDirect: true,
      status: "idle",
      provider: "claude",
      createdAt: now,
      updatedAt: now,
    });

    const git = makeGitService();
    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => ({
        startSession: vi.fn(async () => "session-id"),
        stopSession: vi.fn(),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
      }) as never,
      gitService: git as never,
    });

    await expect(svc.createWorkspace({
      issueId,
      branch: "feature/ak-1-test",
      isDirect: false,
      skipSetup: true,
      skipContextPacker: true,
    })).rejects.toBeInstanceOf(WorkspaceError);

    expect(git.createWorktree).not.toHaveBeenCalled();
    expect(git.removeWorktree).not.toHaveBeenCalled();
  });
});
