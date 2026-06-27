// @covers workspaces.create.one-direct-per-issue [error]
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceCrudService } from "../services/workspace-crud.service.js";

/**
 * GAP: workspaces.create.one-direct-per-issue [error]
 *
 * Only ONE direct workspace may be open for an issue at a time — direct
 * workspaces all share the project's main checkout, so a second one would
 * collide on the same working tree. When an issue already has an open direct
 * workspace, a *direct* create for that same issue must be REFUSED.
 *
 * The existing workspace-create-harden.test.ts asserts the leftover guard fires
 * for a NON-direct create. This test covers the specific two-direct-workspaces
 * error path: the second create is itself `isDirect: true` (the real
 * "one direct per issue" semantic) and asserts the exact refusal shape.
 *
 * Mutation: drop assertNoOpenDirectWorkspaceForIssue → the second direct create
 * proceeds (resolves with a new workspace row instead of rejecting) →
 * this test goes RED at the rejects.toMatchObject / row-count assertions.
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
    title: "One direct workspace per issue",
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

describe("one direct workspace per issue (error path)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses a second DIRECT workspace while the issue already has an open one", async () => {
    const { issueId } = await seedIssue(db);
    const now = new Date().toISOString();

    // First (open) direct workspace already exists for the issue.
    await db.insert(workspaces).values({
      id: "first-direct",
      issueId,
      branch: "main",
      workingDir: "/tmp/repo",
      baseBranch: null,
      isDirect: true,
      status: "active",
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

    // Attempt a SECOND direct workspace for the same issue — must be refused.
    await expect(svc.createWorkspace({
      issueId,
      branch: "main",
      isDirect: true,
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
      data: expect.objectContaining({ code: "OPEN_DIRECT_WORKSPACE", workspaceId: "first-direct" }),
    });

    // No agent launched, no second row inserted — the issue keeps exactly one direct workspace.
    expect(sessionManager.startSession).not.toHaveBeenCalled();
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.issueId, issueId));
    expect(wsRows).toHaveLength(1);
    expect(wsRows[0].id).toBe("first-direct");
  });
});
