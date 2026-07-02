/**
 * Regression test for issue #950:
 * Exit classification must survive a server restart. The workflow engine tracks
 * review / fix-and-merge / learning sessions in process-local Sets, but a session
 * REATTACHED after a restart exits into EMPTY sets. Classification must therefore
 * fall back to the persisted `sessions.triggerType` (the source of truth) — a
 * reattached review session routed to the builder handler bounced the issue back
 * to In Review and spawned another review (the stranded-review/review-loop class).
 *
 * Every test here deliberately does NOT add the session id to the engine's Sets —
 * that is the restart simulation.
 */

// Mock modules that exit-workflow.ts loads at import time.
const checkBranchTipIsAncestorMock = vi.hoisted(() => vi.fn());
vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../services/git.service.js", () => ({
  prepareForReview: vi.fn(async () => ({ success: true, diffRef: "master", conflictingFiles: [], uncommittedChanges: [] })),
  checkBranchTipIsAncestor: checkBranchTipIsAncestorMock,
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
  applyWorkspaceProfileToPrefs: vi.fn((m: Map<string, string>) => m),
}));
vi.mock("../startup/merge-strategy.js", () => ({
  isAutomaticMergeEnabled: vi.fn(() => false),
}));
// hasCommittedChanges uses execFile — report a diff (err) so the branch "has changes".
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
 * Seed a project (In Progress / In Review / Done), an issue, a workspace, and one
 * session whose PERSISTED triggerType is given. The session id is NOT registered
 * in any engine Set — simulating a session reattached after a server restart.
 */
async function seedRestartScenario(
  db: ReturnType<typeof createTestDb>["db"],
  opts: { triggerType: string | null; issueStatus?: "In Progress" | "In Review"; workspaceStatus?: string },
) {
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
    id: issueId, issueNumber: 950, title: "Restart-surviving exit classification",
    priority: "high", sortOrder: 0,
    statusId: opts.issueStatus === "In Progress" ? inProgressId : inReviewId,
    projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId,
    branch: "feature/ak-950-test",
    workingDir: "/repo/.worktrees/ak-950-test",
    baseBranch: "master",
    isDirect: false,
    status: opts.workspaceStatus ?? "reviewing",
    readyForMerge: false,
    provider: "claude",
    createdAt: now, updatedAt: now,
  });
  await db.insert(sessions).values({
    id: sessionId, workspaceId,
    status: "running",
    triggerType: opts.triggerType,
    createdAt: now, updatedAt: now,
  });

  return { projectId, issueId, workspaceId, sessionId, inProgressId, inReviewId };
}

function makeEngine(db: ReturnType<typeof createTestDb>["db"], autoMerge = vi.fn(async () => {})) {
  const sessionManager = makeSessionManager();
  const engine = createWorkflowEngine({
    sessionManager: sessionManager as never,
    boardEvents: makeBoardEvents() as never,
    autoMerge,
    database: db as never,
  });
  return { engine, sessionManager, autoMerge };
}

describe("exit-workflow: classification survives restart via persisted triggerType (#950)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
    checkBranchTipIsAncestorMock.mockReset();
    // Branch landed — keeps the #764 stranded-resolver guard a no-op in fix cases.
    checkBranchTipIsAncestorMock.mockResolvedValue({ isAncestor: true, branchSha: "abc", baseSha: "abc" });
  });

  it("routes a reattached review session (triggerType=review, absent from Sets) to the REVIEW handler", async () => {
    const { workspaceId, sessionId } = await seedRestartScenario(db, { triggerType: "review" });
    const { engine, sessionManager } = makeEngine(db);

    // The restart case: reviewSessionIds is EMPTY — no engine.reviewSessionIds.add().
    await engine.runWorkflowOnExit(workspaceId, sessionId, /* exitCode */ 0);

    // The review terminal handler approves the branch: readyForMerge=true.
    // The (wrong) builder handler would NEVER set readyForMerge — it would instead
    // bounce the issue and spawn ANOTHER review session.
    const [ws] = await db.select({ readyForMerge: workspaces.readyForMerge })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.readyForMerge).toBe(true);
    // No second review spawned — the review-loop symptom.
    expect(sessionManager.startSession).not.toHaveBeenCalled();
  });

  it("routes a reattached fix-and-merge session (absent from Sets) to the FIX-AND-MERGE handler", async () => {
    const { workspaceId, sessionId } = await seedRestartScenario(db, { triggerType: "fix-and-merge", workspaceStatus: "fixing" });
    const autoMerge = vi.fn(async () => {});
    const { engine, sessionManager } = makeEngine(db, autoMerge);

    await engine.runWorkflowOnExit(workspaceId, sessionId, 0);

    // The fix-and-merge handler retries the merge; the builder handler never calls autoMerge
    // (isAutomaticMergeEnabled is mocked false, so no other path reaches it).
    expect(autoMerge).toHaveBeenCalledTimes(1);
    expect(sessionManager.startSession).not.toHaveBeenCalled();
  });

  it("routes a reattached resolve-conflicts session (triggerType=fix-conflicts) to the FIX-AND-MERGE handler", async () => {
    const { workspaceId, sessionId } = await seedRestartScenario(db, { triggerType: "fix-conflicts", workspaceStatus: "fixing" });
    const autoMerge = vi.fn(async () => {});
    const { engine } = makeEngine(db, autoMerge);

    await engine.runWorkflowOnExit(workspaceId, sessionId, 0);

    expect(autoMerge).toHaveBeenCalledTimes(1);
  });

  it("routes a reattached learning session (absent from Sets) to learning-cleanup — no workflow action", async () => {
    const { workspaceId, sessionId, issueId, inProgressId } = await seedRestartScenario(db, {
      triggerType: "learning", issueStatus: "In Progress", workspaceStatus: "active",
    });
    const autoMerge = vi.fn(async () => {});
    const { engine, sessionManager } = makeEngine(db, autoMerge);

    await engine.runWorkflowOnExit(workspaceId, sessionId, 0);

    // Learning cleanup takes no board action: issue stays In Progress (the builder
    // handler would have moved it to In Review — the branch "has changes" here).
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    expect(issue.statusId).toBe(inProgressId);
    expect(autoMerge).not.toHaveBeenCalled();
    expect(sessionManager.startSession).not.toHaveBeenCalled();
  });

  it("still routes a builder-like session (triggerType=agent, absent from Sets) to the BUILDER handler", async () => {
    const { workspaceId, sessionId, issueId, inReviewId } = await seedRestartScenario(db, {
      triggerType: "agent", issueStatus: "In Progress", workspaceStatus: "active",
    });
    const { engine } = makeEngine(db);

    await engine.runWorkflowOnExit(workspaceId, sessionId, 0);

    // The builder handler moves the committed-changes issue to In Review — the
    // triggerType fallback must not over-trigger and hijack real builder exits.
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    expect(issue.statusId).toBe(inReviewId);
    // readyForMerge untouched — no review verdict was applied.
    const [ws] = await db.select({ readyForMerge: workspaces.readyForMerge })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.readyForMerge).toBe(false);
  });

  it("routes a reattached review session that exits NON-zero to the FAILED handler (no verdict applied)", async () => {
    const { workspaceId, sessionId } = await seedRestartScenario(db, { triggerType: "review" });
    const { engine } = makeEngine(db);

    await engine.runWorkflowOnExit(workspaceId, sessionId, /* exitCode */ 1);

    // A crashed reviewer must never have its "verdict" applied — readyForMerge stays false.
    const [ws] = await db.select({ readyForMerge: workspaces.readyForMerge })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.readyForMerge).toBe(false);
  });
});
