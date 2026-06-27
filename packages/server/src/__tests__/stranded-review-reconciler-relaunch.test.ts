// @covers review-merge.reconcile.stranded-review [workflow,state-transition,config]
/**
 * Core honesty-restoration coverage for the stranded-review reconciler (ticket #529).
 *
 * The sibling `stranded-review-reconciler.test.ts` only proves the DISABLE/no-op path:
 * it asserts ZERO mutations when the reconciler is turned off. That leaves the actual
 * recovery behaviour — the whole reason the reconciler exists — completely unverified.
 * A regression that stopped relaunching reviews for genuinely stranded In-Review work
 * would still pass that suite while silently stranding tickets in "In Review" forever.
 *
 * This test asserts the RELAUNCH path:
 *   1. A genuinely stranded workspace (idle, In Review, NOT ready-for-merge, has commits
 *      ahead of base, no running session, no prior review session) gets its review
 *      RE-LAUNCHED via startManualReview.
 *   2. The reconciler is DISCRIMINATING — it does NOT relaunch a workspace that has
 *      already been reviewed (prior review session present); that one stays untouched.
 *   3. With auto_review OFF, the stranded workspace is instead marked readyForMerge=true
 *      so the merge orchestrator can take it (the config dimension of the behaviour).
 *
 * The agent/session boundary is mocked: we replace `startManualReview` (so no real agent
 * spawns) and `getCommitCountAhead` (so we don't need a real git worktree), exactly the
 * way neighbouring reconciler tests isolate the side-effecting boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, preferences, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import type { BoardEvents } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";

// Mock the agent/session boundary so no real review agent spawns. The reconciler
// imports startManualReview directly; we assert it is (or is not) invoked.
const startManualReviewMock = vi.fn(async () => ({ sessionId: randomUUID() }));
vi.mock("../services/review.service.js", () => ({
  startManualReview: (...args: unknown[]) => startManualReviewMock(...args),
}));

// Mock the git boundary so "has commits ahead of base" is deterministic without a
// real worktree on disk (the working dirs below never exist).
const getCommitCountAheadMock = vi.fn(async () => 1);
vi.mock("../services/git.service.js", () => ({
  getCommitCountAhead: (...args: unknown[]) => getCommitCountAheadMock(...args),
}));

// Import AFTER the mocks are registered (vi.mock is hoisted, but keep it explicit).
const { reconcileStrandedReviews } = await import("../startup/stranded-review-reconciler.js");

type Db = ReturnType<typeof createTestDb>["db"];

function makeDeps(db: Db, overrides: Partial<{ enabled: boolean }> = {}) {
  const boardEvents = { broadcast: vi.fn() } as unknown as BoardEvents;
  const sessionManager = {} as SessionManager;
  return {
    database: db,
    getSessionManager: () => sessionManager,
    boardEvents,
    reviewSessionIds: new Set<string>(),
    ...overrides,
  };
}

async function seedProject(db: Db) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const doneStatusId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
  ]);
  return { projectId, inReviewStatusId, doneStatusId };
}

/** Seed an idle, In-Review, not-ready, non-direct workspace (a recovery candidate). */
async function seedInReviewWorkspace(
  db: Db,
  opts: { projectId: string; statusId: string; issueNumber: number },
) {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(issues).values({
    id: issueId, issueNumber: opts.issueNumber, title: `Issue ${opts.issueNumber}`,
    priority: "medium", sortOrder: 0, statusId: opts.statusId, projectId: opts.projectId,
    createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: `feature/ak-${opts.issueNumber}`,
    workingDir: `/repo/.worktrees/ws-${opts.issueNumber}`, baseBranch: "master",
    isDirect: false, status: "idle", readyForMerge: false, mergedAt: null,
    provider: "claude", createdAt: now, updatedAt: now,
  });
  return { issueId, workspaceId };
}

describe("reconcileStrandedReviews — relaunch path (recovers stranded reviews, #529)", () => {
  beforeEach(() => {
    startManualReviewMock.mockClear();
    getCommitCountAheadMock.mockClear();
    getCommitCountAheadMock.mockResolvedValue(1);
  });

  it("relaunches review for a genuinely stranded In-Review workspace", async () => {
    const { db } = createTestDb();
    const { projectId, inReviewStatusId } = await seedProject(db);
    const { workspaceId } = await seedInReviewWorkspace(db, { projectId, statusId: inReviewStatusId, issueNumber: 529 });

    const recovered = await reconcileStrandedReviews(makeDeps(db));

    expect(recovered).toBe(1);
    expect(startManualReviewMock).toHaveBeenCalledTimes(1);
    // 5th positional arg of startManualReview is the workspaceId.
    expect(startManualReviewMock.mock.calls[0][4]).toBe(workspaceId);
  });

  it("does NOT relaunch a workspace that already has a prior review session", async () => {
    const { db } = createTestDb();
    const { projectId, inReviewStatusId } = await seedProject(db);
    // Genuinely stranded — should be recovered.
    const stranded = await seedInReviewWorkspace(db, { projectId, statusId: inReviewStatusId, issueNumber: 529 });
    // Already reviewed — has a completed review session; must be left alone.
    const reviewed = await seedInReviewWorkspace(db, { projectId, statusId: inReviewStatusId, issueNumber: 530 });
    await db.insert(sessions).values({
      id: randomUUID(), workspaceId: reviewed.workspaceId, status: "stopped",
      triggerType: "review", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    });

    const recovered = await reconcileStrandedReviews(makeDeps(db));

    expect(recovered).toBe(1);
    expect(startManualReviewMock).toHaveBeenCalledTimes(1);
    const relaunchedIds = startManualReviewMock.mock.calls.map((c) => c[4]);
    expect(relaunchedIds).toContain(stranded.workspaceId);
    expect(relaunchedIds).not.toContain(reviewed.workspaceId);
  });

  it("marks the stranded workspace ready-for-merge (no relaunch) when auto_review is off", async () => {
    const { db } = createTestDb();
    const { projectId, inReviewStatusId } = await seedProject(db);
    const { workspaceId } = await seedInReviewWorkspace(db, { projectId, statusId: inReviewStatusId, issueNumber: 529 });

    const now = new Date().toISOString();
    await db.insert(preferences)
      .values({ key: "auto_review", value: "false", updatedAt: now })
      .onConflictDoUpdate({ target: preferences.key, set: { value: "false", updatedAt: now } });

    const recovered = await reconcileStrandedReviews(makeDeps(db));

    expect(recovered).toBe(1);
    // Config dimension: with auto_review off the reconciler must NOT spawn a review,
    // it restores honesty by promoting the workspace for the merge orchestrator.
    expect(startManualReviewMock).not.toHaveBeenCalled();
    const [row] = await db.select({ readyForMerge: workspaces.readyForMerge })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(row.readyForMerge).toBe(true);
  });
});
