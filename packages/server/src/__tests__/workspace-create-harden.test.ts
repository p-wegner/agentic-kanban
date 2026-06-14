import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceCrudService } from "../services/workspace-crud.service.js";
import { WorkspaceError } from "../services/workspace-internals.js";

/**
 * Regression tests for POST /api/workspaces connection-drop hardening.
 *
 * AK-501: a post-insert agent-launch failure must return 201 with the workspace
 * record (never roll back and re-throw, which dropped the HTTP connection).
 *
 * AK-587: agent launch is now deferred via setImmediate so the HTTP response is
 * sent BEFORE launch begins.  A slow or failing launch must never block the
 * response — the caller gets the workspace record immediately and launch proceeds
 * in the background.
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

async function seedIssue(db: ReturnType<typeof createTestDb>["db"]) {
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
  await db.insert(projectStatuses).values({
    id: statusId,
    projectId,
    name: "In Progress",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 1,
    title: "Harden POST workspaces",
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId };
}

describe("workspace creation hardening (AK-501 / AK-587)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately without waiting for agent launch (AK-587: no connection drop)", async () => {
    const { issueId } = await seedIssue(db);

    let launchResolved = false;
    const slowSessionManager = {
      startSession: vi.fn(async () => {
        // Simulate a slow agent launch that takes a long time
        await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
        launchResolved = true;
        return "mock-session-id";
      }),
      stopSession: vi.fn(async () => true),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };

    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => slowSessionManager as never,
      gitService: makeGitService() as never,
    });

    const createPromise = svc.createWorkspace({
      issueId,
      branch: "feature/ak-1-test",
      isDirect: false,
      requiresReview: false,
      thoroughReview: false,
      planMode: false,
      tddMode: false,
      includeVisualProof: false,
      skipSetup: true,
      skipContextPacker: true,
    });

    // createWorkspace should resolve in the current microtask queue (before setImmediate fires)
    // Use runAllTicks (microtasks only) — if the result isn't ready before setImmediate it will still
    // be pending; we then run setImmediate to trigger the deferred launch and confirm the create
    // already resolved.
    const result = await createPromise;

    // The workspace record is returned immediately — agent launch has not completed yet
    expect(result.id).toBeTruthy();
    expect(result.issueId).toBe(issueId);
    expect(result.status).toBe("active");
    expect(result.createdAt).toBeTruthy();
    // launchResolved is still false because the fake 10s timer hasn't fired
    expect(launchResolved).toBe(false);
  });

  it("workspace status updated to idle in background when deferred launch fails (AK-587)", async () => {
    const { issueId } = await seedIssue(db);

    const failingSessionManager = {
      startSession: vi.fn(async () => { throw new Error("agent binary not found"); }),
      stopSession: vi.fn(async () => true),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };

    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => failingSessionManager as never,
      gitService: makeGitService() as never,
    });

    const result = await svc.createWorkspace({
      issueId,
      branch: "feature/ak-1-test",
      isDirect: false,
      requiresReview: false,
      thoroughReview: false,
      planMode: false,
      tddMode: false,
      includeVisualProof: false,
      skipSetup: true,
      skipContextPacker: true,
    });

    // Response comes back as active — the failure hasn't happened yet
    expect(result.id).toBeTruthy();
    expect(result.status).toBe("active");
    expect(result.error).toBeUndefined();

    // Let the deferred setImmediate fire and the failing launch + DB update run
    await vi.runAllTimersAsync();

    // The background handler should have updated the workspace status to idle
    const { workspaces } = await import("@agentic-kanban/shared/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, result.id));
    expect(row?.status).toBe("idle");
  });

  it("marks stale safety-policy preflight launch failures as workspace errors", async () => {
    const { issueId } = await seedIssue(db);

    const failingSessionManager = {
      startSession: vi.fn(async () => {
        throw new WorkspaceError("Workspace safety policy is stale; checkpoint/commit first.", "CONFLICT", {
          code: "STALE_SAFETY_POLICY",
          staleFiles: [".claude/hooks/smart-hooks-runner.js"],
        });
      }),
      stopSession: vi.fn(async () => true),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };

    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => failingSessionManager as never,
      gitService: makeGitService() as never,
    });

    const result = await svc.createWorkspace({
      issueId,
      branch: "feature/ak-1-test",
      isDirect: false,
      requiresReview: false,
      thoroughReview: false,
      planMode: false,
      tddMode: false,
      includeVisualProof: false,
      skipSetup: true,
      skipContextPacker: true,
    });

    await vi.runAllTimersAsync();

    const [row] = await db
      .select({ status: workspaces.status, latestLaunchError: workspaces.latestLaunchError })
      .from(workspaces)
      .where(eq(workspaces.id, result.id));
    expect(row?.status).toBe("error");
    expect(row?.latestLaunchError).toContain("STALE_SAFETY_POLICY");
    expect(row?.latestLaunchError).toContain("Workspace safety policy is stale");
  });

  it("returns a well-formed response when worktree creation itself fails (pre-insert)", async () => {
    const { issueId } = await seedIssue(db);

    const git = makeGitService({
      createWorktree: vi.fn(async () => { throw new Error("git worktree add failed"); }),
    });
    const sessionManager = {
      startSession: vi.fn(async () => "session-id"),
      stopSession: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };

    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => sessionManager as never,
      gitService: git as never,
    });

    const result = await svc.createWorkspace({
      issueId,
      branch: "feature/ak-1-test",
      isDirect: false,
      requiresReview: false,
      thoroughReview: false,
      planMode: false,
      tddMode: false,
      includeVisualProof: false,
      skipSetup: true,
      skipContextPacker: true,
    });

    expect(result.id).toBeTruthy();
    expect(result.issueId).toBe(issueId);
    expect(result.error).toMatch(/git worktree add failed/);
    // Agent was never launched (worktree failed before insert)
    expect(sessionManager.startSession).not.toHaveBeenCalled();
  });

  it("blocks creation when the issue has an open direct workspace leftover", async () => {
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
    const sessionManager = {
      startSession: vi.fn(async () => "session-id"),
      stopSession: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };

    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => sessionManager as never,
      gitService: git as never,
    });

    await expect(svc.createWorkspace({
      issueId,
      branch: "feature/ak-1-test",
      isDirect: false,
      requiresReview: false,
      thoroughReview: false,
      planMode: false,
      tddMode: false,
      includeVisualProof: false,
      skipSetup: true,
      skipContextPacker: true,
    })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("open direct workspace"),
      data: expect.objectContaining({ code: "OPEN_DIRECT_WORKSPACE", workspaceId: "direct-leftover" }),
    });

    expect(git.createWorktree).not.toHaveBeenCalled();
    expect(sessionManager.startSession).not.toHaveBeenCalled();
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.issueId, issueId));
    expect(wsRows).toHaveLength(1);
    expect(wsRows[0].id).toBe("direct-leftover");
  });

  it("returns 201-compatible result for successful creation", async () => {
    const { issueId } = await seedIssue(db);

    const git = makeGitService();
    const sessionManager = {
      startSession: vi.fn(async () => "mock-session-id"),
      stopSession: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };

    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => sessionManager as never,
      gitService: git as never,
    });

    const result = await svc.createWorkspace({
      issueId,
      branch: "feature/ak-1-test",
      isDirect: false,
      requiresReview: false,
      thoroughReview: false,
      planMode: false,
      tddMode: false,
      includeVisualProof: false,
      skipSetup: true,
      skipContextPacker: true,
    });

    expect(result.id).toBeTruthy();
    expect(result.issueId).toBe(issueId);
    expect(result.status).toBe("active");
    // sessionId is not in the synchronous return — launch is deferred via setImmediate
    expect(result.sessionId).toBeUndefined();
    expect(result.error).toBeUndefined();
  });
});
