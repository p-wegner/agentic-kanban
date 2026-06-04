import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceCrudService } from "../services/workspace-crud.service.js";

/**
 * Regression tests for AK-501: POST /api/workspaces must always return a
 * well-formed response — never drop the HTTP connection.
 *
 * Previously, a post-insert agent-launch failure would roll back the workspace
 * row and re-throw, causing the route to return 500 and the connection to be
 * dropped. The monitor would then retry and create a duplicate workspace.
 *
 * After the fix: any failure that occurs after the workspace row is committed
 * returns 201 with the workspace record and an `error` field — identical to the
 * pre-insert failure path (handleCreateFailure).
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

describe("workspace creation hardening (AK-501)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("returns a well-formed response when agent launch fails after worktree is created", async () => {
    const { issueId } = await seedIssue(db);

    const git = makeGitService();
    const failingSessionManager = {
      startSession: vi.fn(async () => { throw new Error("agent binary not found"); }),
      stopSession: vi.fn(async () => true),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };

    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => failingSessionManager as never,
      gitService: git as never,
    });

    // Must resolve — not throw — even when agent launch fails
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

    // Response must be a well-formed workspace record
    expect(result.id).toBeTruthy();
    expect(result.issueId).toBe(issueId);
    expect(result.branch).toBe("feature/ak-1-test");
    // Error field signals that launch failed without 500
    expect(result.error).toMatch(/agent binary not found/);
    // Status should be idle (row exists, agent never started)
    expect(result.status).toBe("idle");
    // Response has required timestamp fields
    expect(result.createdAt).toBeTruthy();
    expect(result.updatedAt).toBeTruthy();
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
    expect(result.sessionId).toBe("mock-session-id");
    expect(result.error).toBeUndefined();
  });
});
