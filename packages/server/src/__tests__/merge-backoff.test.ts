// @covers review-merge.merge.retry-backoff [workflow,state-transition,resilience]
/**
 * Exponential backoff / circuit breaker for monitor merge + fix-and-merge retries (#417).
 *
 * Observed: an eventhub workspace had fix-and-merge retried every ~9-10 minutes,
 * indefinitely, against two static human-only blockers (dirty main checkout; missing
 * gradle distribution zip). Each retry paid main-checkout git checks plus a full Gradle
 * verify run, and nothing surfaced the blockers. These tests pin the ticket's acceptance
 * criteria: identical failure twice → next attempt scheduled with a doubled delay;
 * relevant state change resets the block; the warning surfaces after 2 repeats; the
 * state is persisted (a "restart" — fresh call, no in-memory carry-over — still honors
 * the backoff); non-retryable classes go straight to the max backoff.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { driveObstacles, issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";

const emitButlerSystemEventMock = vi.fn();
vi.mock("../services/butler-event-feed.js", () => ({
  emitButlerSystemEvent: (...args: unknown[]) => emitButlerSystemEventMock(...args),
}));

const {
  MERGE_BACKOFF_BASE_MS,
  MERGE_BACKOFF_CAP_MS,
  MERGE_BACKOFF_WARN_REPEATS,
  classifyMergeFailure,
  clearMergeBackoff,
  computeMergeFailureSignature,
  nextRetryDelayMs,
  recordMergeFailure,
  shouldSkipMergeForBackoff,
} = await import("../services/merge-backoff.service.js");

type Db = ReturnType<typeof createTestDb>["db"];

const T0 = new Date("2026-08-11T18:00:00.000Z");
const atMs = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

const DIRTY_MAIN_MSG = "Main checkout has 1 uncommitted tracked change(s) — cannot merge workspace ws1. Commit or stash those changes first.";
const VERIFY_INFRA_MSG = "Pre-merge gate failed (verify) — merge withheld. Could not find C:\\tools\\gradle-9.6.1-bin.zip (no such file or directory)";
const GENERIC_MSG = "Merge conflicts detected (branch is 3 commit(s) behind master)";

async function seedWorkspace(db: Db, issueNumber: number) {
  const now = T0.toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber, title: `Issue ${issueNumber}`, priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: `feature/ak-${issueNumber}`,
    workingDir: `/repo/.worktrees/ws-${issueNumber}`, baseBranch: "master",
    isDirect: false, status: "idle", readyForMerge: true, mergedAt: null,
    provider: "claude", createdAt: now, updatedAt: now,
  });
  return {
    projectId,
    workspaceId,
    ref: { wsId: workspaceId, projectId, workingDir: `/repo/.worktrees/ws-${issueNumber}`, issueNumber },
  };
}

function readBackoff(db: Db, workspaceId: string) {
  return db.select({
    failures: workspaces.mergeBackoffFailures,
    signature: workspaces.mergeBackoffSignature,
    error: workspaces.mergeBackoffError,
    branchSha: workspaces.mergeBackoffBranchSha,
    verifyHash: workspaces.mergeBackoffVerifyHash,
    nextRetryAt: workspaces.mergeBackoffNextRetryAt,
    since: workspaces.mergeBackoffSince,
  }).from(workspaces).where(eq(workspaces.id, workspaceId)).then((r) => r[0]);
}

/** Deterministic deps: injected clock + probes, no real git/prefs. */
function makeDeps(db: Db, now: Date, overrides: Record<string, unknown> = {}) {
  return {
    database: db,
    now: () => now,
    getBranchHeadSha: vi.fn(async () => "head1"),
    isMainCheckoutClean: vi.fn(async () => false),
    getVerifyScriptHash: vi.fn(async () => "vh1"),
    ...overrides,
  };
}

beforeEach(() => {
  emitButlerSystemEventMock.mockClear();
});

describe("failure classification (#417 part 3)", () => {
  it("classifies a dirty main checkout as non-retryable-without-change", () => {
    expect(classifyMergeFailure(DIRTY_MAIN_MSG)).toBe("main_checkout_dirty");
  });

  it("classifies file-not-found in verify output as verify_infra_missing", () => {
    expect(classifyMergeFailure(VERIFY_INFRA_MSG)).toBe("verify_infra_missing");
    expect(classifyMergeFailure("Pre-merge gate failed (verify) — merge withheld. ENOENT: spawn ./gradlew")).toBe("verify_infra_missing");
  });

  it("a verify failure that is a real test failure stays generic (retryable ramp)", () => {
    expect(classifyMergeFailure("Pre-merge gate failed (verify) — merge withheld. 3 tests failed")).toBe("generic");
    expect(classifyMergeFailure(GENERIC_MSG)).toBe("generic");
  });

  it("non-retryable classes jump straight to the max backoff; generic doubles per repeat", () => {
    expect(nextRetryDelayMs("main_checkout_dirty", 1)).toBe(MERGE_BACKOFF_CAP_MS);
    expect(nextRetryDelayMs("verify_infra_missing", 1)).toBe(MERGE_BACKOFF_CAP_MS);
    expect(nextRetryDelayMs("generic", 1)).toBe(MERGE_BACKOFF_BASE_MS);
    expect(nextRetryDelayMs("generic", 2)).toBe(2 * MERGE_BACKOFF_BASE_MS);
    expect(nextRetryDelayMs("generic", 3)).toBe(4 * MERGE_BACKOFF_BASE_MS);
    expect(nextRetryDelayMs("generic", 20)).toBe(MERGE_BACKOFF_CAP_MS);
  });

  it("signature normalizes counts so '1 change' and '2 changes' are the same blocker", () => {
    const a = computeMergeFailureSignature("main_checkout_dirty", "Main checkout has 1 uncommitted tracked change(s)");
    const b = computeMergeFailureSignature("main_checkout_dirty", "Main checkout has 2 uncommitted tracked change(s)");
    expect(a).toBe(b);
    expect(a.startsWith("main_checkout_dirty|")).toBe(true);
  });
});

describe("exponential backoff on identical failures (#417 part 1)", () => {
  it("identical failure twice → the next attempt is scheduled with a DOUBLED delay", async () => {
    const { db } = createTestDb();
    const { workspaceId, ref } = await seedWorkspace(db, 417);

    const first = await recordMergeFailure(ref, GENERIC_MSG, makeDeps(db, T0));
    expect(first?.failures).toBe(1);
    expect(first?.nextRetryAt).toBe(atMs(MERGE_BACKOFF_BASE_MS).toISOString());

    const t1 = atMs(MERGE_BACKOFF_BASE_MS);
    const second = await recordMergeFailure(ref, GENERIC_MSG, makeDeps(db, t1));
    expect(second?.failures).toBe(2);
    expect(second?.nextRetryAt).toBe(new Date(t1.getTime() + 2 * MERGE_BACKOFF_BASE_MS).toISOString());

    const row = await readBackoff(db, workspaceId);
    expect(row.failures).toBe(2);
    expect(row.since).toBe(T0.toISOString()); // "since when" pinned to the FIRST identical failure
  });

  it("a DIFFERENT failure signature restarts the count instead of ramping", async () => {
    const { db } = createTestDb();
    const { ref } = await seedWorkspace(db, 418);
    await recordMergeFailure(ref, GENERIC_MSG, makeDeps(db, T0));
    const other = await recordMergeFailure(ref, "index.lock held by another process", makeDeps(db, atMs(1000)));
    expect(other?.failures).toBe(1);
    expect(other?.nextRetryAt).toBe(new Date(atMs(1000).getTime() + MERGE_BACKOFF_BASE_MS).toISOString());
  });

  it("skips inside the window and allows the attempt once the window has elapsed", async () => {
    const { db } = createTestDb();
    const { ref } = await seedWorkspace(db, 419);
    await recordMergeFailure(ref, GENERIC_MSG, makeDeps(db, T0));

    const during = await shouldSkipMergeForBackoff(ref, makeDeps(db, atMs(MERGE_BACKOFF_BASE_MS - 1000)));
    expect(during.skip).toBe(true);
    expect(during.reason).toContain("generic");

    const after = await shouldSkipMergeForBackoff(ref, makeDeps(db, atMs(MERGE_BACKOFF_BASE_MS)));
    expect(after.skip).toBe(false);
  });

  it("a non-retryable class (dirty main) is at max backoff from the FIRST failure", async () => {
    const { db } = createTestDb();
    const { ref } = await seedWorkspace(db, 420);
    const rec = await recordMergeFailure(ref, DIRTY_MAIN_MSG, makeDeps(db, T0));
    expect(rec?.failureClass).toBe("main_checkout_dirty");
    expect(rec?.nextRetryAt).toBe(atMs(MERGE_BACKOFF_CAP_MS).toISOString());

    const decision = await shouldSkipMergeForBackoff(ref, makeDeps(db, atMs(90 * 60_000)));
    expect(decision.skip).toBe(true);
  });

  it("restart preserves the backoff — a fresh call with no in-memory state still skips", async () => {
    const { db } = createTestDb();
    const { workspaceId, ref } = await seedWorkspace(db, 421);
    await recordMergeFailure(ref, DIRTY_MAIN_MSG, makeDeps(db, T0));

    // Everything the breaker knows is on the workspace row, so a "restarted server"
    // (fresh deps object, same DB) makes the same decision.
    const row = await readBackoff(db, workspaceId);
    expect(row.failures).toBe(1);
    expect(row.signature).toContain("main_checkout_dirty|");
    expect(row.nextRetryAt).toBeTruthy();
    expect(row.error).toContain("uncommitted tracked change");

    const decision = await shouldSkipMergeForBackoff(ref, makeDeps(db, atMs(60_000)));
    expect(decision.skip).toBe(true);
  });
});

describe("state changes reset the backoff (#417 part 1)", () => {
  it("a new commit on the branch clears the block", async () => {
    const { db } = createTestDb();
    const { workspaceId, ref } = await seedWorkspace(db, 422);
    await recordMergeFailure(ref, DIRTY_MAIN_MSG, makeDeps(db, T0)); // stores branchSha=head1

    const deps = makeDeps(db, atMs(60_000), { getBranchHeadSha: vi.fn(async () => "head2") });
    const decision = await shouldSkipMergeForBackoff(ref, deps);
    expect(decision.skip).toBe(false);
    expect((await readBackoff(db, workspaceId)).failures).toBe(0);
  });

  it("the main checkout becoming clean clears a dirty-main block", async () => {
    const { db } = createTestDb();
    const { workspaceId, ref } = await seedWorkspace(db, 423);
    await recordMergeFailure(ref, DIRTY_MAIN_MSG, makeDeps(db, T0));

    const deps = makeDeps(db, atMs(60_000), { isMainCheckoutClean: vi.fn(async () => true) });
    const decision = await shouldSkipMergeForBackoff(ref, deps);
    expect(decision.skip).toBe(false);
    expect((await readBackoff(db, workspaceId)).failures).toBe(0);
  });

  it("an UNKNOWN main-checkout state keeps a dirty-main block (fail closed)", async () => {
    const { db } = createTestDb();
    const { ref } = await seedWorkspace(db, 424);
    await recordMergeFailure(ref, DIRTY_MAIN_MSG, makeDeps(db, T0));

    const deps = makeDeps(db, atMs(60_000), { isMainCheckoutClean: vi.fn(async () => null) });
    expect((await shouldSkipMergeForBackoff(ref, deps)).skip).toBe(true);
  });

  it("changed verify-script content clears a verify-infra block", async () => {
    const { db } = createTestDb();
    const { workspaceId, ref } = await seedWorkspace(db, 425);
    await recordMergeFailure(ref, VERIFY_INFRA_MSG, makeDeps(db, T0)); // stores verifyHash=vh1

    const deps = makeDeps(db, atMs(60_000), { getVerifyScriptHash: vi.fn(async () => "vh2") });
    const decision = await shouldSkipMergeForBackoff(ref, deps);
    expect(decision.skip).toBe(false);
    expect((await readBackoff(db, workspaceId)).failures).toBe(0);
  });

  it("clearMergeBackoff resets everything (the merge-success path)", async () => {
    const { db } = createTestDb();
    const { workspaceId, ref } = await seedWorkspace(db, 426);
    await recordMergeFailure(ref, GENERIC_MSG, makeDeps(db, T0));
    await clearMergeBackoff(db, workspaceId);
    const row = await readBackoff(db, workspaceId);
    expect(row.failures).toBe(0);
    expect(row.signature).toBeNull();
    expect(row.nextRetryAt).toBeNull();
    expect((await shouldSkipMergeForBackoff(ref, makeDeps(db, atMs(1000)))).skip).toBe(false);
  });
});

describe("surfacing the blocker (#417 part 2)", () => {
  it("records ONE merge_retry_blocked drive obstacle when the failure repeats, not one per cycle", async () => {
    const { db } = createTestDb();
    const { projectId, ref } = await seedWorkspace(db, 427);

    const first = await recordMergeFailure(ref, DIRTY_MAIN_MSG, makeDeps(db, T0));
    expect(first?.warned).toBe(false);
    expect(await db.select().from(driveObstacles).where(eq(driveObstacles.projectId, projectId))).toHaveLength(0);

    const second = await recordMergeFailure(ref, DIRTY_MAIN_MSG, makeDeps(db, atMs(MERGE_BACKOFF_CAP_MS)));
    expect(second?.warned).toBe(true);
    expect(second?.failures).toBe(MERGE_BACKOFF_WARN_REPEATS);

    await recordMergeFailure(ref, DIRTY_MAIN_MSG, makeDeps(db, atMs(2 * MERGE_BACKOFF_CAP_MS)));

    const rows = await db.select().from(driveObstacles).where(eq(driveObstacles.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("merge_retry_blocked");
    expect(rows[0].issueNumber).toBe(427);
    expect(rows[0].summary).toContain("main_checkout_dirty");
    expect(rows[0].summary).toContain(T0.toISOString()); // names since-when
    expect(rows[0].summary).toContain(ref.wsId); // names the workspace
    expect(emitButlerSystemEventMock).toHaveBeenCalledTimes(1);
  });
});

describe("mergeWorkspaceWithFixFallback wiring (#417)", () => {
  it("records the failure (still launching fix-and-merge) and clears the backoff on success", async () => {
    const { mergeWorkspaceWithFixFallback } = await import("../startup/monitor-cycle-actions.js");
    const { RUN_GATE } = await import("../services/pre-merge-gate.service.js");
    const { db } = createTestDb();
    const { workspaceId, ref } = await seedWorkspace(db, 428);
    const [wsRow] = await db.select({ issueId: workspaces.issueId }).from(workspaces).where(eq(workspaces.id, workspaceId));
    const candidate = {
      wsId: workspaceId, wsStatus: "idle", workingDir: ref.workingDir, isDirect: false,
      projectId: ref.projectId, issueId: wsRow.issueId, issueTitle: "t", issueNumber: 428,
      issueStatusName: "In Review", baseBranch: "master", readyForMerge: true,
    };
    const fixAndMerge = vi.fn(async () => {});
    const actions = {
      launch: vi.fn(), delete: vi.fn(), updateBase: vi.fn(),
      merge: vi.fn(async () => { throw new Error(DIRTY_MAIN_MSG); }),
      fixAndMerge,
    };
    const logs = { conflictMsg: "conflict", successMsg: "ok" };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mergeWorkspaceWithFixFallback(candidate as any, actions as any, () => {}, logs, RUN_GATE, makeDeps(db, T0));
    expect(fixAndMerge).toHaveBeenCalledWith(workspaceId, DIRTY_MAIN_MSG);
    const afterFail = await readBackoff(db, workspaceId);
    expect(afterFail.failures).toBe(1);
    expect(afterFail.signature).toContain("main_checkout_dirty|");

    actions.merge = vi.fn(async () => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mergeWorkspaceWithFixFallback(candidate as any, actions as any, () => {}, logs, RUN_GATE, makeDeps(db, atMs(MERGE_BACKOFF_CAP_MS)));
    expect((await readBackoff(db, workspaceId)).failures).toBe(0);
  });
});
