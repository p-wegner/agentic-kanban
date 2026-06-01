import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, projectStatuses, issues, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import { createWorkspaceSessionService } from "../services/workspace-session.service.js";
import { WorkspaceError } from "../services/workspace.service.js";

/**
 * Regression tests for AK-300: null-workingDir workspaces could not be relaunched.
 *
 * Historically: POST /api/workspaces/:id/launch returned 500 ("Workspace has no
 * working directory; run setup first") for any workspace with workingDir = null.
 *
 * After the fix: launch auto-rebuilds the worktree via setupWorkspace, then proceeds.
 * If setup fails, it throws a typed BAD_REQUEST WorkspaceError (400) instead of 500.
 */

async function seedNullWorkdirWorkspace(
  db: TestDb,
  opts: { defaultBranch?: string | null } = {},
): Promise<{ workspaceId: string; issueId: string; projectId: string }> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const issueId = randomUUID();
  const statusId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: "/tmp/repo", repoName: "repo",
    defaultBranch: opts.defaultBranch === undefined ? "main" : opts.defaultBranch,
    createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 1, title: "Fix bug", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1-fix",
    workingDir: null,
    baseBranch: "main", isDirect: false, status: "idle", provider: "claude",
    createdAt: now, updatedAt: now,
  });

  return { workspaceId, issueId, projectId };
}

describe("null-workingDir launch regression (AK-300)", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("auto-rebuilds the worktree and launches when workingDir is null", async () => {
    const { workspaceId } = await seedNullWorkdirWorkspace(db);
    const sessionManager = createMockSessionManager();

    const rebuiltPath = "/tmp/repo/.worktrees/feature-ak-1-fix";
    const setupWorkspace = vi.fn(async (id: string) => ({ id, workingDir: rebuiltPath }));

    const service = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => sessionManager,
      setupWorkspace,
    });

    const result = await service.launchSession(workspaceId);

    expect(result.sessionId).toBeTruthy();
    expect(setupWorkspace).toHaveBeenCalledWith(workspaceId);
    expect(sessionManager.startSession).toHaveBeenCalledOnce();

    // workingDir is now set in the DB (setupWorkspace mock updates it)
    // The launch should have proceeded using the rebuilt path
    expect(setupWorkspace).toHaveBeenCalledOnce();
  });

  it("throws a typed BAD_REQUEST (not generic 500) when setup fails on a null-workingDir workspace", async () => {
    const { workspaceId } = await seedNullWorkdirWorkspace(db);
    const sessionManager = createMockSessionManager();

    const setupWorkspace = vi.fn(async (_id: string) => {
      throw new Error("git: branch does not exist");
    });

    const service = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => sessionManager,
      setupWorkspace,
    });

    await expect(service.launchSession(workspaceId)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(sessionManager.startSession).not.toHaveBeenCalled();
  });

  it("does not attempt setup for direct workspaces even if workingDir is null", async () => {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const statusId = randomUUID();
    const workspaceId = randomUUID();

    await db.insert(projects).values({
      id: projectId, name: "P", repoPath: "/tmp/direct-repo", repoName: "repo",
      defaultBranch: "main", createdAt: now, updatedAt: now,
    });
    await db.insert(projectStatuses).values({
      id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId, issueNumber: 2, title: "Direct task", priority: "medium", sortOrder: 0,
      statusId, projectId, createdAt: now, updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch: "main",
      workingDir: null,
      baseBranch: null, isDirect: true, status: "idle", provider: "claude",
      createdAt: now, updatedAt: now,
    });

    const sessionManager = createMockSessionManager();
    const setupWorkspace = vi.fn();

    const service = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => sessionManager,
      setupWorkspace,
    });

    // Direct workspace with null workingDir should not call setup — the session
    // manager itself will handle the missing workingDir (or it's set at repoPath level).
    // We only verify setup is NOT called; the session may still fail for other reasons.
    try {
      await service.launchSession(workspaceId);
    } catch {
      // may throw for unrelated reasons (session-lifecycle null workingDir check)
    }

    expect(setupWorkspace).not.toHaveBeenCalled();
  });
});
