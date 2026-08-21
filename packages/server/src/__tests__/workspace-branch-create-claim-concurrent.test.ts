// @covers workspaces.create.branch-create-claim [error]
//
// #673 item 1: issue #670 held TWO open workspace records, created 9 seconds apart by two
// different starters (the monitor auto-start and a manual `POST /api/workspaces`), on the
// SAME branch and sharing one worktree — the monitor relaunched both, running two agents
// concurrently in one working directory. `auto-start-claim.ts` (#366) already serializes
// AUTOMATIC starters against each other by issueId, but explicitly exempts anything that
// isn't an automatic starter, so a manual create racing an automatic one (or two manual
// creates) for the SAME issue's default branch was never guarded. This test exercises the
// CONCURRENT path (two overlapping createWorkspace calls, not two sequential ones) and
// asserts exactly one wins.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceCrudService } from "../services/workspace-crud.service.js";
import { resetBranchCreateClaims } from "../services/workspace-branch-create-claim.js";

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
    id: projectId, name: "Test Project", repoPath: "/tmp/repo", repoName: "repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 670, title: "Two workspaces for one issue", description: null,
    priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  return { projectId, issueId };
}

describe("createWorkspace refuses a concurrent same-issue/same-branch race (#673)", () => {
  beforeEach(() => {
    resetBranchCreateClaims();
  });

  afterEach(() => {
    resetBranchCreateClaims();
  });

  it("lets exactly one of two overlapping creates for the same issue+default-branch win", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedIssue(db);

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

    const makeInput = () => ({
      issueId, isDirect: false, requiresReview: false, thoroughReview: false,
      planMode: false, tddMode: false, includeVisualProof: false,
      skipSetup: true, skipContextPacker: true,
    });

    // Neither call passes an explicit `branch` — both derive the SAME default branch via
    // suggestBranchName(issue), reproducing #670's real-world collision. Fired concurrently
    // (no sequential await between them), the way the monitor auto-start and a manual POST
    // actually overlapped.
    const results = await Promise.allSettled([
      svc.createWorkspace(makeInput()),
      svc.createWorkspace(makeInput()),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("already in flight"),
      data: expect.objectContaining({ code: "BRANCH_CREATE_IN_FLIGHT", issueId }),
    });

    // Only ONE workspace row landed for the issue — no shared-worktree duplicate.
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.issueId, issueId));
    expect(wsRows).toHaveLength(1);

    // The loser's branch is free again afterward — a genuine retry (or a deliberate second
    // workspace on a different branch) is not permanently blocked by the failed race.
    const retry = await svc.createWorkspace(makeInput());
    expect(retry.id).not.toBe(wsRows[0].id);
  });

  it("does NOT block a deliberate second workspace for the same issue on a DIFFERENT branch", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedIssue(db);

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

    const results = await Promise.allSettled([
      svc.createWorkspace({
        issueId, isDirect: false, branch: "feature/ak-670-a", requiresReview: false, thoroughReview: false,
        planMode: false, tddMode: false, includeVisualProof: false, skipSetup: true, skipContextPacker: true,
      }),
      svc.createWorkspace({
        issueId, isDirect: false, branch: "feature/ak-670-b", requiresReview: false, thoroughReview: false,
        planMode: false, tddMode: false, includeVisualProof: false, skipSetup: true, skipContextPacker: true,
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.issueId, issueId));
    expect(wsRows).toHaveLength(2);
  });
});
