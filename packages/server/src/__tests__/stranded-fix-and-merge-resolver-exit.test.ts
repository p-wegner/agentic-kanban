/**
 * Regression test for issue #764:
 * The LOSER of a concurrent merge race gets a fix-and-merge resolver session. When that
 * resolver exits WITHOUT the branch actually landing (the conflict against the moved base
 * is real, so autoMerge's plumbing merge throws and is swallowed), the workspace must be
 * left OPEN and idle (retryable) — NOT closed, never stranding the ticket workspace-less and
 * unmerged. Conversely, when the resolver DID land the branch, the guard is a no-op (autoMerge
 * already closed the workspace). Complements #761/#762.
 */

// Mock modules that exit-workflow.ts loads at import time.
const checkBranchTipIsAncestorMock = vi.hoisted(() => vi.fn());
vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../services/git.service.js", () => ({
  prepareForReview: vi.fn(async () => ({ success: true, diffRef: "master", conflictingFiles: [], uncommittedChanges: [] })),
  checkBranchTipIsAncestor: checkBranchTipIsAncestorMock,
}));
const emitButlerSystemEventMock = vi.hoisted(() => vi.fn());
vi.mock("../services/butler-event-feed.js", () => ({ emitButlerSystemEvent: emitButlerSystemEventMock }));
vi.mock("../services/agent-settings.service.js", () => ({
  isMockProfile: vi.fn(() => false),
  toExecutorProvider: vi.fn((p: string) => p),
  MOCK_AGENT_COMMAND: "mock",
}));
vi.mock("../startup/review-helpers.js", () => ({
  buildReviewArgs: vi.fn(() => undefined),
  buildReviewPrompt: vi.fn(async () => ({ prompt: "review", model: undefined })),
  getEffectiveProfile: vi.fn(() => undefined),
  parseProviderPref: vi.fn(() => "claude"),
  applyWorkspaceProfileToPrefs: vi.fn((m: Map<string, string>) => m),
}));
vi.mock("../startup/merge-strategy.js", () => ({
  isAutomaticMergeEnabled: vi.fn(() => false),
}));
// hasCommittedChanges uses execFile — make it report a diff (err) so the branch "has changes".
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => cb(new Error("diff")),
    ),
  };
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkflowEngine } from "../startup/exit-workflow.js";

function makeBoardEvents() {
  return { broadcast: vi.fn(), broadcastActivity: vi.fn() };
}

function makeSessionManager() {
  return { startSession: vi.fn(async () => randomUUID()) };
}

/**
 * Seed a project with In Progress / In Review / Done statuses; issue In Review.
 * The workspace is in "fixing" with readyForMerge=true (the state a fix-and-merge
 * resolver leaves it in while running), and a fix-and-merge session.
 */
async function seedFixingWorkspace(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inProgressId = randomUUID();
  const inReviewId = randomUUID();
  const doneId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inProgressId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now },
    { id: inReviewId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now },
    { id: doneId, projectId, name: "Done", sortOrder: 2, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId, issueNumber: 764, title: "Concurrent-merge loser",
    priority: "medium", sortOrder: 0,
    statusId: inReviewId,
    projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId,
    branch: "feature/ak-764-test",
    workingDir: "/repo/.worktrees/ak-764-test",
    baseBranch: "master",
    isDirect: false,
    status: "fixing",
    readyForMerge: true,
    provider: "claude",
    createdAt: now, updatedAt: now,
  });
  await db.insert(sessions).values({
    id: sessionId, workspaceId,
    status: "running",
    createdAt: now, updatedAt: now,
  });

  return { projectId, issueId, workspaceId, sessionId };
}

async function getWorkspace(db: ReturnType<typeof createTestDb>["db"], workspaceId: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  return ws;
}

describe("exit-workflow: stranded fix-and-merge resolver (issue #764)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
    checkBranchTipIsAncestorMock.mockReset();
    emitButlerSystemEventMock.mockReset();
  });

  it("keeps the workspace OPEN and idle (retryable) when the resolver exits but the branch did NOT land", async () => {
    const { projectId, issueId, workspaceId, sessionId } = await seedFixingWorkspace(db);

    // Branch did NOT land: the concurrent-merge loser whose conflict is real.
    checkBranchTipIsAncestorMock.mockResolvedValue({ isAncestor: false, branchSha: "abc", baseSha: "def" });

    const boardEvents = makeBoardEvents();
    // autoMerge that fails to land (swallows its own conflict error — mirrors real autoMerge).
    const autoMerge = vi.fn(async () => {});

    const engine = createWorkflowEngine({
      sessionManager: makeSessionManager() as never,
      boardEvents: boardEvents as never,
      autoMerge,
      database: db as never,
    });
    // Register this as a fix-and-merge session (mirrors fixAndMerge() launch bookkeeping).
    engine.fixAndMergeSessionIds.add(sessionId);

    await engine.runWorkflowOnExit(workspaceId, sessionId, /* exitCode */ 0);

    const ws = await getWorkspace(db, workspaceId);
    // The crux: NOT closed — the ticket must never be left workspace-less.
    expect(ws.status).toBe("idle");
    expect(ws.status).not.toBe("closed");
    expect(ws.workingDir).not.toBeNull();
    // Stale readyForMerge cleared so a conflicted branch is not re-treated as mergeable.
    expect(ws.readyForMerge).toBe(false);
    // A clear, surfaced signal for the retry.
    expect(emitButlerSystemEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId, workspaceId, kind: "merge_failed" }),
    );
    void issueId;
  });

  it("keeps the workspace open + idle even when the resolver exits NON-zero without landing", async () => {
    const { workspaceId, sessionId } = await seedFixingWorkspace(db);
    checkBranchTipIsAncestorMock.mockResolvedValue({ isAncestor: false, branchSha: "abc", baseSha: "def" });

    const boardEvents = makeBoardEvents();
    const engine = createWorkflowEngine({
      sessionManager: makeSessionManager() as never,
      boardEvents: boardEvents as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });
    engine.fixAndMergeSessionIds.add(sessionId);

    await engine.runWorkflowOnExit(workspaceId, sessionId, /* exitCode */ 1);

    const ws = await getWorkspace(db, workspaceId);
    expect(ws.status).toBe("idle");
    expect(ws.status).not.toBe("closed");
    expect(ws.readyForMerge).toBe(false);
  });

  it("does NOT reopen/touch the workspace when the resolver DID land the branch (autoMerge closed it)", async () => {
    const { workspaceId, sessionId } = await seedFixingWorkspace(db);

    // Branch landed: it is now an ancestor of base.
    checkBranchTipIsAncestorMock.mockResolvedValue({ isAncestor: true, branchSha: "abc", baseSha: "abc" });

    const boardEvents = makeBoardEvents();
    // autoMerge that lands the branch: closes the workspace + stamps mergedAt (mirrors real autoMerge).
    const autoMerge = vi.fn(async () => {
      const now = new Date().toISOString();
      await db.update(workspaces)
        .set({ status: "closed", workingDir: null, mergedAt: now, readyForMerge: false, updatedAt: now })
        .where(eq(workspaces.id, workspaceId));
    });

    const engine = createWorkflowEngine({
      sessionManager: makeSessionManager() as never,
      boardEvents: boardEvents as never,
      autoMerge,
      database: db as never,
    });
    engine.fixAndMergeSessionIds.add(sessionId);

    await engine.runWorkflowOnExit(workspaceId, sessionId, 0);

    const ws = await getWorkspace(db, workspaceId);
    // Stays closed/merged — the guard must not reopen a successfully-landed workspace.
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).not.toBeNull();
    // The guard short-circuits before any ancestry check is needed for a closed workspace.
    expect(checkBranchTipIsAncestorMock).not.toHaveBeenCalled();
  });
});
