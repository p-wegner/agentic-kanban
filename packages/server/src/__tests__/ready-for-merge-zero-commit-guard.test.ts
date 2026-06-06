/**
 * Regression test for issue #629:
 * A 0-commit feature branch (branch tip == base) must NOT have readyForMerge=true.
 * Race path: a review session completes, but the branch has been reset/rebased
 * to equal base by the time the review exits. The review-exit handler must
 * re-verify committed changes before setting readyForMerge=true.
 */

// Mock modules that exit-workflow.ts loads at import time
vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../services/git.service.js", () => ({
  prepareForReview: vi.fn(async () => ({ success: true, diffRef: "master", conflictingFiles: [], uncommittedChanges: [] })),
}));
vi.mock("../services/butler-event-feed.js", () => ({ emitButlerSystemEvent: vi.fn() }));
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
}));
vi.mock("../startup/merge-strategy.js", () => ({
  isAutomaticMergeEnabled: vi.fn(() => false),
}));
// hasCommittedChanges uses execFile — make it return exit code 0 (no diff = 0 commits)
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => cb(null),
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

/** Seed a project with statuses, an issue in In Review, and a workspace with a review session. */
async function seedReviewExitScenario(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inProgressId = randomUUID();
  const inReviewId = randomUUID();
  const doneId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const reviewSessionId = randomUUID();

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
    id: issueId, issueNumber: 629, title: "Zero-commit readyForMerge guard",
    priority: "medium", sortOrder: 0,
    statusId: inReviewId,
    projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId,
    branch: "feature/ak-629-test",
    workingDir: "/repo/.worktrees/ak-629-test",
    baseBranch: "master",
    isDirect: false,
    status: "idle",
    readyForMerge: false,
    provider: "claude",
    createdAt: now, updatedAt: now,
  });
  await db.insert(sessions).values({
    id: reviewSessionId, workspaceId,
    status: "running",
    triggerType: "review",
    createdAt: now, updatedAt: now,
  });

  return { projectId, issueId, workspaceId, reviewSessionId, inReviewId };
}

describe("exit-workflow: review-exit guard against 0-commit readyForMerge (issue #629)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("does NOT set readyForMerge=true when review exits but branch has no committed changes", async () => {
    const { workspaceId, reviewSessionId } = await seedReviewExitScenario(db);

    const boardEvents = makeBoardEvents();
    const sessionManager = makeSessionManager();

    const engine = createWorkflowEngine({
      sessionManager: sessionManager as never,
      boardEvents: boardEvents as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    // Simulate the race: the review was launched (session ID in reviewSessionIds)
    // but by the time it exits, the branch has 0 commits (execFile mock returns no-diff).
    engine.reviewSessionIds.add(reviewSessionId);

    await engine.runWorkflowOnExit(workspaceId, reviewSessionId, /* exitCode */ 0);

    // readyForMerge must remain false — the branch has no committed changes
    const [ws] = await db.select({ readyForMerge: workspaces.readyForMerge, status: workspaces.status })
      .from(workspaces).where(eq(workspaces.id, workspaceId));

    expect(ws.readyForMerge).toBe(false);
  });

  it("keeps workspace idle and in In Review when review exits on 0-commit branch", async () => {
    const { workspaceId, reviewSessionId, issueId, inReviewId } = await seedReviewExitScenario(db);

    const boardEvents = makeBoardEvents();
    const sessionManager = makeSessionManager();

    const engine = createWorkflowEngine({
      sessionManager: sessionManager as never,
      boardEvents: boardEvents as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    engine.reviewSessionIds.add(reviewSessionId);

    await engine.runWorkflowOnExit(workspaceId, reviewSessionId, 0);

    // Workspace stays idle (not closed, not merged)
    const [ws] = await db.select({ status: workspaces.status })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("idle");

    // Issue stays In Review
    const [issue] = await db.select({ statusId: issues.statusId })
      .from(issues).where(eq(issues.id, issueId));
    expect(issue.statusId).toBe(inReviewId);
  });

  it("does NOT broadcast workspace_ready_for_merge for 0-commit review exit", async () => {
    const { workspaceId, reviewSessionId, projectId } = await seedReviewExitScenario(db);

    const boardEvents = makeBoardEvents();
    const sessionManager = makeSessionManager();

    const engine = createWorkflowEngine({
      sessionManager: sessionManager as never,
      boardEvents: boardEvents as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    engine.reviewSessionIds.add(reviewSessionId);

    await engine.runWorkflowOnExit(workspaceId, reviewSessionId, 0);

    // Must NOT broadcast the ready-for-merge event
    expect(boardEvents.broadcast).not.toHaveBeenCalledWith(projectId, "workspace_ready_for_merge");
  });
});
