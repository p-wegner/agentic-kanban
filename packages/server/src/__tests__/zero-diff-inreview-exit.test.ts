/**
 * Regression test for issue #603:
 * A non-direct workspace that is already In Review but has zero committed changes
 * (zero-diff) must be closed and moved to Done on agent session exit — not left
 * stranded in In Review with readyForMerge=false where it blocks the Done transition.
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
// hasCommittedChanges uses execFile — make it return exit code 0 (no diff)
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

/** Seed a project with In Progress / In Review / Done statuses; issue starts In Review. */
async function seedInReviewWorkspace(db: ReturnType<typeof createTestDb>["db"]) {
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
    id: issueId, issueNumber: 603, title: "Zero-diff In Review",
    priority: "medium", sortOrder: 0,
    statusId: inReviewId,
    projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId,
    branch: "feature/ak-603-test",
    workingDir: "/repo/.worktrees/ak-603-test",
    baseBranch: "master",
    isDirect: false,
    status: "idle",
    readyForMerge: false,
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

async function getIssueStatusName(db: ReturnType<typeof createTestDb>["db"], issueId: string): Promise<string> {
  const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
  const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
  return status.name;
}

describe("exit-workflow: zero-diff In Review → Done (issue #603)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("closes workspace and moves issue to Done when In Review with no committed changes", async () => {
    const { issueId, workspaceId, sessionId } = await seedInReviewWorkspace(db);

    const boardEvents = makeBoardEvents();
    const sessionManager = makeSessionManager();

    const { runWorkflowOnExit } = createWorkflowEngine({
      sessionManager: sessionManager as never,
      boardEvents: boardEvents as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    await runWorkflowOnExit(workspaceId, sessionId, /* exitCode */ 0);

    // Issue must be Done — not stranded in In Review
    expect(await getIssueStatusName(db, issueId)).toBe("Done");

    // Workspace must be closed
    const [ws] = await db.select({ status: workspaces.status })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
  });

  it("leaves In Progress issue untouched when no committed changes", async () => {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const inProgressId = randomUUID();
    const doneId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    await db.insert(projects).values({
      id: projectId, name: "T", repoPath: "/r", repoName: "r",
      defaultBranch: "master", createdAt: now, updatedAt: now,
    });
    await db.insert(projectStatuses).values([
      { id: inProgressId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now },
      { id: doneId, projectId, name: "Done", sortOrder: 1, isDefault: false, createdAt: now },
    ]);
    await db.insert(issues).values({
      id: issueId, issueNumber: 604, title: "In Progress issue",
      priority: "medium", sortOrder: 0,
      statusId: inProgressId,
      projectId, createdAt: now, updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId, issueId,
      branch: "feature/ak-604-test",
      workingDir: "/r/.worktrees/ak-604",
      baseBranch: "master",
      isDirect: false,
      status: "idle",
      readyForMerge: false,
      provider: "claude",
      createdAt: now, updatedAt: now,
    });
    await db.insert(sessions).values({
      id: sessionId, workspaceId,
      status: "running",
      createdAt: now, updatedAt: now,
    });

    const boardEvents = makeBoardEvents();
    const sessionManager = makeSessionManager();

    const { runWorkflowOnExit } = createWorkflowEngine({
      sessionManager: sessionManager as never,
      boardEvents: boardEvents as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    await runWorkflowOnExit(workspaceId, sessionId, 0);

    // Issue must remain In Progress — the zero-diff shortcut only triggers for In Review
    expect(await getIssueStatusName(db, issueId)).toBe("In Progress");

    // Workspace must NOT be closed
    const [ws] = await db.select({ status: workspaces.status })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).not.toBe("closed");
  });
});
