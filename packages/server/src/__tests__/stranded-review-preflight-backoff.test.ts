// @covers review-merge.reconcile.stranded-review [workflow,state-transition,resilience]
/**
 * Backoff for unresolvable review preflights (#283).
 *
 * `startManualReview` runs a rebase preflight. When the branch conflicts with its base it
 * throws, the reconciler logged the failure and moved on — and because nothing was
 * recorded, the NEXT cycle 60 seconds later did the exact same rebase again. One observed
 * dev-server run: 5 workspaces, 48 failure events, 39 rebase attempts, and it would have
 * continued forever. A rebase is the most expensive git operation the board runs and it is
 * synchronous CreateProcess work on the event-loop thread, so this was directly visible as
 * multi-second API latency every cycle.
 *
 * The fix is deliberately NOT a blind attempt counter. A conflict is deterministic *given
 * the same two commits*, so the block is keyed on a `<headSha>..<baseSha>` signature: while
 * the tips are unchanged the reconciler gives up after MAX_REVIEW_PREFLIGHT_ATTEMPTS and
 * reports a drive obstacle; the moment either tip moves — an agent pushed a fix, master
 * advanced — the block clears itself and the work is retried. These tests pin both halves,
 * plus the cost claim (a blocked workspace must not reach the expensive git call at all).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, workspaces, driveObstacles } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import type { BoardEvents } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";

const startManualReviewMock = vi.fn(async () => ({ sessionId: randomUUID() }));
const isReviewLaunchPendingMock = vi.fn(() => false);
vi.mock("../services/review.service.js", () => ({
  startManualReview: (...args: unknown[]) => startManualReviewMock(...args),
  isReviewLaunchPending: (...args: unknown[]) => isReviewLaunchPendingMock(...args),
}));

const getCommitCountAheadMock = vi.fn(async () => 1);
const revParseMock = vi.fn(async (_dir: string, ref: string) => (ref === "HEAD" ? "head1" : "base1"));
vi.mock("../services/git.service.js", () => ({
  getCommitCountAhead: (...args: unknown[]) => getCommitCountAheadMock(...args),
  revParse: (...args: [string, string]) => revParseMock(...args),
}));

const { reconcileStrandedReviews, MAX_REVIEW_PREFLIGHT_ATTEMPTS, clearReviewPreflightBlock } =
  await import("../startup/stranded-review-reconciler.js");
const { resetMergeJobs } = await import("../services/merge-job.service.js");

type Db = ReturnType<typeof createTestDb>["db"];

function makeDeps(db: Db) {
  const boardEvents = { broadcast: vi.fn() } as unknown as BoardEvents;
  return {
    database: db,
    getSessionManager: () => ({} as SessionManager),
    boardEvents,
    reviewSessionIds: new Set<string>(),
    // #539: the commits-ahead probe is now the leading-OR-sibling helper, which reaches the
    // git-service SSOT in @agentic-kanban/shared — out of reach of the git.service mock
    // above. The reconciler exposes it as a dep, so the same mock still drives it.
    hasCommittedWork: async () => (await getCommitCountAheadMock()) > 0,
  };
}

async function seedCandidate(db: Db, issueNumber: number) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber, title: `Issue ${issueNumber}`, priority: "medium", sortOrder: 0,
    statusId: inReviewStatusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: `feature/ak-${issueNumber}`,
    workingDir: `/repo/.worktrees/ws-${issueNumber}`, baseBranch: "master",
    isDirect: false, status: "idle", readyForMerge: false, mergedAt: null,
    provider: "claude", createdAt: now, updatedAt: now,
  });
  return { projectId, workspaceId };
}

function readBlock(db: Db, workspaceId: string) {
  return db.select({
    failures: workspaces.reviewPreflightFailures,
    signature: workspaces.reviewPreflightSignature,
    error: workspaces.reviewPreflightError,
    blockedAt: workspaces.reviewPreflightBlockedAt,
  }).from(workspaces).where(eq(workspaces.id, workspaceId)).then((r) => r[0]);
}

/** Make the preflight conflict, the way a real rebase conflict surfaces. */
function failPreflight() {
  startManualReviewMock.mockRejectedValue(
    new Error("Rebase conflict during review preflight: 2 file(s) conflict. Route to fix-and-merge to resolve."),
  );
}

describe("stranded-review reconciler — unresolvable preflight backoff (#283)", () => {
  beforeEach(() => {
    startManualReviewMock.mockReset();
    startManualReviewMock.mockResolvedValue({ sessionId: randomUUID() });
    getCommitCountAheadMock.mockClear();
    getCommitCountAheadMock.mockResolvedValue(1);
    isReviewLaunchPendingMock.mockClear();
    isReviewLaunchPendingMock.mockReturnValue(false);
    revParseMock.mockClear();
    revParseMock.mockImplementation(async (_dir: string, ref: string) => (ref === "HEAD" ? "head1" : "base1"));
    resetMergeJobs();
  });

  it("stops retrying after the attempt budget and never spawns another preflight", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seedCandidate(db, 283);
    failPreflight();

    for (let i = 0; i < MAX_REVIEW_PREFLIGHT_ATTEMPTS; i++) {
      await reconcileStrandedReviews(makeDeps(db));
    }
    expect(startManualReviewMock).toHaveBeenCalledTimes(MAX_REVIEW_PREFLIGHT_ATTEMPTS);

    // The behaviour this ticket is about: further cycles must cost nothing.
    await reconcileStrandedReviews(makeDeps(db));
    await reconcileStrandedReviews(makeDeps(db));
    expect(startManualReviewMock).toHaveBeenCalledTimes(MAX_REVIEW_PREFLIGHT_ATTEMPTS);

    const block = await readBlock(db, workspaceId);
    expect(block.failures).toBe(MAX_REVIEW_PREFLIGHT_ATTEMPTS);
    expect(block.blockedAt).toBeTruthy();
    expect(block.error).toContain("Rebase conflict");
    expect(block.signature).toBe("head1..base1");
  });

  it("does not even reach the ahead-count git call once blocked", async () => {
    const { db } = createTestDb();
    await seedCandidate(db, 284);
    failPreflight();

    for (let i = 0; i < MAX_REVIEW_PREFLIGHT_ATTEMPTS; i++) {
      await reconcileStrandedReviews(makeDeps(db));
    }
    getCommitCountAheadMock.mockClear();

    await reconcileStrandedReviews(makeDeps(db));

    // Only the two cheap rev-parses that evaluate the block — no ahead-count, no rebase.
    expect(getCommitCountAheadMock).not.toHaveBeenCalled();
  });

  it("records ONE drive obstacle, at the moment the budget is exhausted", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedCandidate(db, 285);
    failPreflight();

    for (let i = 0; i < MAX_REVIEW_PREFLIGHT_ATTEMPTS + 3; i++) {
      await reconcileStrandedReviews(makeDeps(db));
    }

    const rows = await db.select().from(driveObstacles).where(eq(driveObstacles.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("review_preflight_conflict");
    expect(rows[0].issueNumber).toBe(285);
  });

  it("retries again when the branch tip moves — a conflict is only deterministic for the same commits", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seedCandidate(db, 286);
    failPreflight();

    for (let i = 0; i < MAX_REVIEW_PREFLIGHT_ATTEMPTS; i++) {
      await reconcileStrandedReviews(makeDeps(db));
    }
    expect(startManualReviewMock).toHaveBeenCalledTimes(MAX_REVIEW_PREFLIGHT_ATTEMPTS);

    // The agent committed a conflict resolution: HEAD moved, and the preflight now passes.
    revParseMock.mockImplementation(async (_dir: string, ref: string) => (ref === "HEAD" ? "head2" : "base1"));
    startManualReviewMock.mockResolvedValue({ sessionId: randomUUID() });

    const recovered = await reconcileStrandedReviews(makeDeps(db));

    expect(recovered).toBe(1);
    expect(startManualReviewMock).toHaveBeenCalledTimes(MAX_REVIEW_PREFLIGHT_ATTEMPTS + 1);
    // A successful launch clears the block outright.
    const block = await readBlock(db, workspaceId);
    expect(block.failures).toBe(0);
    expect(block.signature).toBeNull();
    expect(block.blockedAt).toBeNull();
  });

  it("retries again when the BASE moves, not just the branch", async () => {
    const { db } = createTestDb();
    await seedCandidate(db, 287);
    failPreflight();

    for (let i = 0; i < MAX_REVIEW_PREFLIGHT_ATTEMPTS; i++) {
      await reconcileStrandedReviews(makeDeps(db));
    }
    revParseMock.mockImplementation(async (_dir: string, ref: string) => (ref === "HEAD" ? "head1" : "base2"));

    await reconcileStrandedReviews(makeDeps(db));

    expect(startManualReviewMock).toHaveBeenCalledTimes(MAX_REVIEW_PREFLIGHT_ATTEMPTS + 1);
  });

  it("counts from zero again after the tips move, rather than blocking on the first new failure", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seedCandidate(db, 288);
    failPreflight();

    for (let i = 0; i < MAX_REVIEW_PREFLIGHT_ATTEMPTS; i++) {
      await reconcileStrandedReviews(makeDeps(db));
    }
    revParseMock.mockImplementation(async (_dir: string, ref: string) => (ref === "HEAD" ? "head2" : "base1"));

    await reconcileStrandedReviews(makeDeps(db));

    const block = await readBlock(db, workspaceId);
    expect(block.failures).toBe(1);
    expect(block.signature).toBe("head2..base1");
    expect(block.blockedAt).toBeNull();
  });

  it("a healthy candidate costs no rev-parse at all", async () => {
    const { db } = createTestDb();
    await seedCandidate(db, 289);

    const recovered = await reconcileStrandedReviews(makeDeps(db));

    expect(recovered).toBe(1);
    // No failures on record, so there is no block to evaluate — the signature is only
    // resolved lazily, on the failure path.
    expect(revParseMock).not.toHaveBeenCalled();
  });

  it("clearReviewPreflightBlock un-blocks a workspace so the next cycle retries it", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seedCandidate(db, 290);
    failPreflight();

    for (let i = 0; i < MAX_REVIEW_PREFLIGHT_ATTEMPTS; i++) {
      await reconcileStrandedReviews(makeDeps(db));
    }
    startManualReviewMock.mockResolvedValue({ sessionId: randomUUID() });
    await reconcileStrandedReviews(makeDeps(db));
    expect(startManualReviewMock).toHaveBeenCalledTimes(MAX_REVIEW_PREFLIGHT_ATTEMPTS);

    await clearReviewPreflightBlock(db, workspaceId);
    const recovered = await reconcileStrandedReviews(makeDeps(db));

    expect(recovered).toBe(1);
    expect(startManualReviewMock).toHaveBeenCalledTimes(MAX_REVIEW_PREFLIGHT_ATTEMPTS + 1);
  });

  it("still blocks when the tips cannot be resolved at all (git unavailable)", async () => {
    const { db } = createTestDb();
    await seedCandidate(db, 291);
    failPreflight();
    revParseMock.mockRejectedValue(new Error("not a git repository"));

    for (let i = 0; i < MAX_REVIEW_PREFLIGHT_ATTEMPTS + 2; i++) {
      await reconcileStrandedReviews(makeDeps(db));
    }

    expect(startManualReviewMock).toHaveBeenCalledTimes(MAX_REVIEW_PREFLIGHT_ATTEMPTS);
  });
});
