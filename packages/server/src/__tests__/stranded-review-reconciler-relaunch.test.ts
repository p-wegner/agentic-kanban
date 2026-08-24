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
import type { startManualReview, isReviewLaunchPending } from "../services/review.service.js";
import type { getCommitCountAhead } from "../services/git.service.js";

// Mock the agent/session boundary so no real review agent spawns. The reconciler
// imports startManualReview directly; we assert it is (or is not) invoked.
const startManualReviewMock = vi.fn<typeof startManualReview>(async () => ({ sessionId: randomUUID() }));
const isReviewLaunchPendingMock = vi.fn<typeof isReviewLaunchPending>(() => false);
vi.mock("../services/review.service.js", () => ({
  startManualReview: (...args: Parameters<typeof startManualReview>) => startManualReviewMock(...args),
  isReviewLaunchPending: (...args: Parameters<typeof isReviewLaunchPending>) => isReviewLaunchPendingMock(...args),
}));

// Mock the git boundary so "has commits ahead of base" is deterministic without a
// real worktree on disk (the working dirs below never exist).
const getCommitCountAheadMock = vi.fn<typeof getCommitCountAhead>(async () => 1);
const revParseMock = vi.fn(async (_dir: string, ref: string) => `sha-${ref}`);
vi.mock("../services/git.service.js", () => ({
  getCommitCountAhead: (...args: Parameters<typeof getCommitCountAhead>) => getCommitCountAheadMock(...args),
  revParse: (...args: [string, string]) => revParseMock(...args),
}));

// Import AFTER the mocks are registered (vi.mock is hoisted, but keep it explicit).
const { reconcileStrandedReviews } = await import("../startup/stranded-review-reconciler.js");
// Real module (not mocked) — the reconciler consults the in-memory merge-job registry (#270).
const { startMergeJob, resetMergeJobs } = await import("../services/merge-job.service.js");

type Db = ReturnType<typeof createTestDb>["db"];

function makeDeps(db: Db, overrides: Partial<{ enabled: boolean }> = {}) {
  const boardEvents = { broadcast: vi.fn() } as unknown as BoardEvents;
  const sessionManager = {} as SessionManager;
  return {
    database: db,
    getSessionManager: () => sessionManager,
    boardEvents,
    reviewSessionIds: new Set<string>(),
    // #539: the commits-ahead probe is now the leading-OR-sibling helper, which reaches the
    // git-service SSOT in @agentic-kanban/shared — out of reach of the git.service mock
    // above. The reconciler exposes it as a dep, so the same mock still drives it.
    hasCommittedWork: async (ws: { workingDir: string | null; baseBranch: string | null }) => ((await getCommitCountAheadMock(ws.workingDir ?? "", ws.baseBranch ?? "")) ?? 0) > 0,
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
    isReviewLaunchPendingMock.mockClear();
    isReviewLaunchPendingMock.mockReturnValue(false);
    resetMergeJobs();
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

  it("does NOT relaunch or promote a fork child (parentWorkspaceId set), even though it looks stranded (#998)", async () => {
    const { db } = createTestDb();
    const { projectId, inReviewStatusId } = await seedProject(db);
    // Genuinely stranded — should be recovered.
    const stranded = await seedInReviewWorkspace(db, { projectId, statusId: inReviewStatusId, issueNumber: 529 });
    // A fork child left "In Review" after its join — must be excluded entirely: no
    // relaunch, no readyForMerge promotion. It is consolidated by the join, not by
    // this legacy reconciler.
    const forkChild = await seedInReviewWorkspace(db, { projectId, statusId: inReviewStatusId, issueNumber: 996 });
    await db.update(workspaces)
      .set({ parentWorkspaceId: stranded.workspaceId, forkStatus: "joined" })
      .where(eq(workspaces.id, forkChild.workspaceId));

    const recovered = await reconcileStrandedReviews(makeDeps(db));

    expect(recovered).toBe(1);
    const relaunchedIds = startManualReviewMock.mock.calls.map((c) => c[4]);
    expect(relaunchedIds).toContain(stranded.workspaceId);
    expect(relaunchedIds).not.toContain(forkChild.workspaceId);
    const [forkRow] = await db.select({ readyForMerge: workspaces.readyForMerge })
      .from(workspaces).where(eq(workspaces.id, forkChild.workspaceId));
    expect(forkRow.readyForMerge).toBe(false);
  });

  it("skips a workspace whose merge is in flight — the merge owns it (#270)", async () => {
    const { db } = createTestDb();
    const { projectId, inReviewStatusId } = await seedProject(db);
    const { workspaceId } = await seedInReviewWorkspace(db, { projectId, statusId: inReviewStatusId, issueNumber: 270 });

    // Without the merge job this candidate WOULD be recovered (proven by the first test).
    startMergeJob(workspaceId);
    const recovered = await reconcileStrandedReviews(makeDeps(db));

    expect(recovered).toBe(0);
    expect(startManualReviewMock).not.toHaveBeenCalled();
  });

  it("skips a workspace whose review launch is already mid-flight on another path (#270)", async () => {
    const { db } = createTestDb();
    const { projectId, inReviewStatusId } = await seedProject(db);
    await seedInReviewWorkspace(db, { projectId, statusId: inReviewStatusId, issueNumber: 271 });

    isReviewLaunchPendingMock.mockReturnValue(true);
    const recovered = await reconcileStrandedReviews(makeDeps(db));

    expect(recovered).toBe(0);
    expect(startManualReviewMock).not.toHaveBeenCalled();
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
