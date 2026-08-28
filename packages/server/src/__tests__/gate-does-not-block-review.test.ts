/**
 * #932 — a single running verify gate must not freeze the board's NON-GATE progress.
 *
 * Observed live: while one merge gate ran (~47 minutes), three workspaces that had FINISHED
 * cleanly (exit 0, commits on their branch) sat `idle` with `readyForMerge: false` and were
 * picked up by nothing. A hand-fired `POST /:id/review` worked immediately for all three.
 * Then one of those reviews completed clean and `readyForMerge` was STILL not flipped, so the
 * workspace went invisible to the monitor a second time and needed a manual
 * `POST /:id/ready-for-merge`.
 *
 * The build semaphore is gate-vs-gate only, so it may gate MERGES — never reviews, the
 * ready-flag transition, or the stranded-review reconciler. These two suites pin exactly that.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../services/butler-event-feed.js", () => ({
  emitButlerSystemEvent: vi.fn(),
}));

vi.mock("@agentic-kanban/shared/lib/workflow-engine", () => ({
  syncCurrentNodeToStatus: vi.fn(),
  transitionIssueStatus: vi.fn(async () => {}),
}));

vi.mock("../repositories/workspace-status.repository.js", () => ({
  setWorkspaceStatus: vi.fn(async () => true),
}));

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { issueComments, issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { reconcileStrandedReviews } from "../startup/stranded-review-reconciler.js";
import { buildSemaphoreActive, runUnderBuildSemaphore } from "../services/jvm-build-semaphore.js";
import { processWorkspaceCandidates, type ProcessWorkspaceDeps, type WorkspaceCandidate } from "../startup/monitor-cycle.js";
import type { BoardEvents } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";

// ---------------------------------------------------------------------------
// Shared harness: hold the build semaphore for the duration of a callback, so the
// assertions below run in the SAME state the live incident happened in.
// ---------------------------------------------------------------------------

/** Run `body` while one task holds a build-semaphore slot, exactly like a live merge gate. */
async function whileGateRunning<T>(body: () => Promise<T>): Promise<T> {
  let releaseGate!: () => void;
  const gateHeld = new Promise<void>((resolve) => { releaseGate = resolve; });
  let observed: T | undefined;
  let failure: unknown;
  const gateTask = runUnderBuildSemaphore(async () => {
    // The gate is now IN FLIGHT — `buildGateBusy()` is true for everything below.
    expect(buildSemaphoreActive()).toBeGreaterThan(0);
    try {
      observed = await body();
    } catch (err) {
      failure = err;
    }
    releaseGate();
  });
  await gateHeld;
  await gateTask;
  if (failure) throw failure;
  return observed as T;
}

// ---------------------------------------------------------------------------
// Half 1 — the monitor cycle still LAUNCHES a review while a gate runs.
// ---------------------------------------------------------------------------

function makeSelectChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const fn of ["from", "where", "orderBy", "innerJoin"]) {
    chain[fn] = () => chain;
  }
  chain.limit = () => Promise.resolve(result);
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  chain.catch = (fn: (e: unknown) => unknown) => Promise.resolve(result).catch(fn);
  return chain as unknown as ReturnType<typeof db.select>;
}

function makeUpdateChain() {
  const chain: Record<string, unknown> = {};
  for (const fn of ["set", "where"]) {
    chain[fn] = () => chain;
  }
  chain.catch = () => Promise.resolve();
  return chain as unknown as ReturnType<typeof db.update>;
}

function makeCycleDeps(): ProcessWorkspaceDeps {
  return {
    sessionManager: { isProcessAlive: vi.fn(() => true), stopSession: vi.fn() } as unknown as ProcessWorkspaceDeps["sessionManager"],
    boardEvents: { broadcast: vi.fn() } as unknown as ProcessWorkspaceDeps["boardEvents"],
    workspaceActions: {
      launch: vi.fn(async () => {}),
      merge: vi.fn(async () => {}),
      fixAndMerge: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      updateBase: vi.fn(async () => {}),
    },
    autoMergeEnabled: true,
    // Off, as it is by default — this is the branch that used to only LOG.
    autoMergeInReview: false,
    reviewSessionIds: new Set<string>(),
    monitorRecentActions: [],
    logMonitorAction: vi.fn(),
    buildMonitorNudgePrompt: vi.fn().mockResolvedValue("nudge"),
    getRecentAgentExcerpts: vi.fn().mockResolvedValue([]),
    shouldSkipNudge: vi.fn().mockReturnValue(false),
    startReview: vi.fn(async () => ({ sessionId: "review-session-1" })) as unknown as ProcessWorkspaceDeps["startReview"],
  };
}

/** The live shape: builder finished (exit 0, commits on branch), issue In Review, never reviewed. */
const completedUnreviewedCandidate: WorkspaceCandidate = {
  wsId: "ws-926",
  wsStatus: "idle",
  workingDir: "/path/to/dir",
  isDirect: false,
  projectId: "proj-1",
  issueId: "issue-926",
  issueTitle: "Completed but unreviewed",
  issueNumber: 926,
  issueStatusName: "In Review",
  baseBranch: "main",
  readyForMerge: false,
  // A non-trivial diff, so the zero-diff "needs attention" dead-end does not claim it.
  diffStatCacheFilesChanged: 3,
  diffStatCacheInsertions: 40,
  diffStatCacheDeletions: 2,
  mergeGateRanAt: null,
  mergeGateStage: null,
  mergeGateSource: null,
};

describe("#932 monitor cycle — a running verify gate does not block review launches", () => {
  beforeEach(() => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([]))            // latest session → none
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }])); // session count → 1 (the builder)
    // Every later read (prior-review probe, merge backoff, …) → empty.
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]));
    vi.mocked(db.update).mockReturnValue(makeUpdateChain());
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("monitor-cycle must not self-HTTP — use the injected workspaceActions port");
    }));
  });

  it("launches a review for a completed, unreviewed workspace WHILE a gate holds the build semaphore", async () => {
    const deps = makeCycleDeps();

    await whileGateRunning(() => processWorkspaceCandidates([completedUnreviewedCandidate], deps));

    // The acceptance criterion: gate running + a completed unreviewed workspace ⇒ review started.
    expect(vi.mocked(deps.startReview!)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.startReview!).mock.calls[0][4]).toBe("ws-926");
    // …and it did NOT instead fall into a relaunch or a merge.
    expect(vi.mocked(deps.workspaceActions.launch)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.workspaceActions.merge)).not.toHaveBeenCalled();
  });

  it("does not re-review a workspace that already has a review session", async () => {
    // The reconciler owns the "reviewed clean but never armed" repair (below); two paths
    // writing that flag would race, so the cycle must stand down once a review exists.
    vi.mocked(db.select).mockReset();
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }]))
      .mockReturnValue(makeSelectChain([{ id: "prior-review-session" }]));
    const deps = makeCycleDeps();

    await whileGateRunning(() => processWorkspaceCandidates([completedUnreviewedCandidate], deps));

    expect(vi.mocked(deps.startReview!)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Half 2 — a clean review arms readyForMerge without a manual POST.
// ---------------------------------------------------------------------------

async function seedReviewedButUnarmedWorkspace(
  database: ReturnType<typeof createTestDb>["db"],
  reviewExit: { exitCode: string | null; status: string },
) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await database.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await database.insert(projectStatuses).values([
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
  ]);
  await database.insert(issues).values({
    id: issueId, issueNumber: 926, title: "Reviewed clean, never armed", priority: "medium",
    sortOrder: 0, statusId: inReviewStatusId, projectId, createdAt: now, updatedAt: now,
  });
  await database.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-926-test", workingDir: "/repo/.worktrees/ws",
    baseBranch: "master", isDirect: false, status: "idle", readyForMerge: false,
    mergedAt: null, provider: "claude", createdAt: now, updatedAt: now,
  });
  await database.insert(sessions).values({
    id: randomUUID(), workspaceId, status: reviewExit.status, triggerType: "review",
    exitCode: reviewExit.exitCode, startedAt: now,
  });

  return { projectId, issueId, workspaceId };
}

function makeReconcilerDeps(database: ReturnType<typeof createTestDb>["db"]) {
  const boardEvents = { broadcast: vi.fn() } as unknown as BoardEvents;
  const startedReviews: string[] = [];
  return {
    startedReviews,
    boardEvents,
    deps: {
      database,
      getSessionManager: () => ({} as SessionManager),
      boardEvents,
      reviewSessionIds: new Set<string>(),
      // The branch really does hold committed work — that is not what is being tested here.
      hasCommittedWork: async () => true,
    },
  };
}

describe("#932 stranded-review reconciler — a clean review arms readyForMerge", () => {
  it("arms readyForMerge when a prior review exited 0 but the flag was never set", async () => {
    const { db: testDb } = createTestDb();
    const { workspaceId, projectId } = await seedReviewedButUnarmedWorkspace(testDb, { exitCode: "0", status: "stopped" });
    const { deps, boardEvents } = makeReconcilerDeps(testDb);

    // Under a running gate, exactly as in the incident.
    const recovered = await whileGateRunning(() => reconcileStrandedReviews(deps));

    expect(recovered).toBe(1);
    const [row] = await testDb.select({ readyForMerge: workspaces.readyForMerge }).from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(row.readyForMerge).toBe(true);
    expect(vi.mocked(boardEvents.broadcast)).toHaveBeenCalledWith(projectId, "workspace_ready_for_merge");
  });

  it("leaves a workspace whose review exited NON-ZERO alone", async () => {
    // A failed review wants a human or a fix session, not an automatic merge approval.
    const { db: testDb } = createTestDb();
    const { workspaceId } = await seedReviewedButUnarmedWorkspace(testDb, { exitCode: "1", status: "stopped" });
    const { deps } = makeReconcilerDeps(testDb);

    const recovered = await reconcileStrandedReviews(deps);

    expect(recovered).toBe(0);
    const [row] = await testDb.select({ readyForMerge: workspaces.readyForMerge }).from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(row.readyForMerge).toBe(false);
  });

  it("leaves a workspace whose review is still RUNNING alone", async () => {
    const { db: testDb } = createTestDb();
    const { workspaceId } = await seedReviewedButUnarmedWorkspace(testDb, { exitCode: null, status: "running" });
    const { deps } = makeReconcilerDeps(testDb);

    const recovered = await reconcileStrandedReviews(deps);

    expect(recovered).toBe(0);
    const [row] = await testDb.select({ readyForMerge: workspaces.readyForMerge }).from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(row.readyForMerge).toBe(false);
  });

  it("does NOT re-arm a clean-reviewed workspace whose merge attempt cleared the flag on purpose", async () => {
    // `recordConflictAndClearReadyFlag` (and the 0-commit ancestor guard, and fix-and-merge's
    // #764 did-not-land path) clear `readyForMerge` precisely so a conflicted branch is not
    // silently re-queued as ready. Its prior review still exited 0, so an arm-on-clean-review
    // rule with no further condition would re-arm it every 60s tick: arm → auto-merge →
    // conflict → clear → arm, forever. The merge-attempt trail is what distinguishes it.
    const { db: testDb } = createTestDb();
    const { workspaceId, issueId } = await seedReviewedButUnarmedWorkspace(testDb, { exitCode: "0", status: "stopped" });
    await testDb.insert(issueComments).values({
      id: randomUUID(), issueId, workspaceId, kind: "merge-attempt", author: "system",
      body: "Merge attempt blocked by conflicts in 2 files: a.ts, b.ts",
      createdAt: new Date().toISOString(),
    });
    const { deps } = makeReconcilerDeps(testDb);

    const recovered = await reconcileStrandedReviews(deps);

    expect(recovered).toBe(0);
    const [row] = await testDb.select({ readyForMerge: workspaces.readyForMerge }).from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(row.readyForMerge).toBe(false);
  });
});
