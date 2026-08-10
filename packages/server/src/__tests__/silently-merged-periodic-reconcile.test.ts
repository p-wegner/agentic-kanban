/**
 * #380 — a merge interrupted between the early `mergedAt` stamp and `finalizeMergeCleanup`
 * must converge WITHOUT a server restart.
 *
 * `reconcileSilentlyMergedWorkspaces` (Path A of the interrupted-merge pair) was wired only
 * into `startup-tasks.ts`, so the recovery for a stranded merged workspace was "wait for the
 * next boot". Path B (`reconcileAncestorBranchWorkspaces`) has always had a periodic
 * cadence; Path A did not, and that asymmetry is the bug: the merge lands, the issue keeps
 * its pre-merge status, and a plugin loop counts the ticket as open — refusing to plan the
 * next round and hiding a live approval gate — until something restarts the server.
 *
 * MEASURED incident this reproduces (linklocker, issue #12, 2026-08-10): `mergedAt`
 * 01:31:15, issue still In Review with an `updatedAt` of 01:17:30, workspace closed only at
 * 01:34:45 by the next boot's startup sweep.
 *
 * These tests assert the WIRING, not just the helper. `reconcile-silently-merged.test.ts`
 * already covers the helper's own behaviour and stays green whether or not anything ever
 * calls it periodically — which is exactly how this gap survived. Deleting the
 * `runSilentlyMergedCompensatorTick` call from `startAncestorBranchReconciler`'s tick must
 * fail the second test here.
 */

// startup-tasks.ts imports db/index.js and several services at module level. Mock them so
// the dynamic import inside runSilentlyMergedCompensatorTick resolves without a real DB.
vi.mock("../db/index.js", () => ({ db: {}, rawClient: {} }));
vi.mock("../db/manual-migrate.js", () => ({ applyMigrations: vi.fn(async () => {}) }));
vi.mock("../services/project-registration.js", () => ({ deduplicateProjects: vi.fn(async () => {}) }));
vi.mock("../services/agent.service.js", () => ({}));
vi.mock("../services/git.service.js", () => ({
  isMergeInProgress: vi.fn(async () => false),
  abortMerge: vi.fn(async () => {}),
  removeWorktree: vi.fn(async () => {}),
  isRebaseInProgress: vi.fn(async () => false),
  abortRebase: vi.fn(async () => {}),
  getChangedFileNames: vi.fn(async () => [] as string[]),
  deleteBranch: vi.fn(async () => {}),
}));
vi.mock("../db/seed.js", () => ({ ensureBuiltinTags: vi.fn(async () => {}), ensureBuiltinSkills: vi.fn(async () => {}) }));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  runSilentlyMergedCompensatorTick,
  startAncestorBranchReconciler,
  stopAncestorBranchReconciler,
} from "../startup/ancestor-branch-reconciler.js";

type TestDb = ReturnType<typeof createTestDb>["db"];

/**
 * Seed the exact post-incident shape: the git merge landed and `mergedAt` is stamped, but
 * `finalizeMergeCleanup` never ran — so the workspace is NOT closed and the issue is still
 * In Review. `skipAutoReview: true` is set because the reported incident was a plugin-loop
 * ticket and the original hypothesis blamed that flag; seeding it true keeps this test
 * honest about the refutation (the transition must happen regardless of it).
 */
async function seedStrandedMergedWorkspace(db: TestDb) {
  const now = new Date().toISOString();
  const mergedAt = new Date(Date.now() - 60_000).toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const doneStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Stranded merge project",
    // No `.git` here on purpose: the sweep's branch delete is best-effort and must not be
    // what decides whether the issue converges.
    repoPath: `/nonexistent-repo-${projectId}`,
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 380,
    title: "PM pipeline 9/9 (revision v2)",
    priority: "medium",
    sortOrder: 0,
    statusId: inReviewStatusId,
    projectId,
    skipAutoReview: true,
    externalKey: "plugin-loop:pm-pipeline:pipeline:step-9:v2",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-380-stranded",
    workingDir: null,
    baseBranch: "master",
    isDirect: false,
    // The shape the incident left behind: the exit workflow had set it idle, and the
    // interrupted merge never got as far as closing it.
    status: "idle",
    readyForMerge: false,
    mergedAt,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId, workspaceId, inReviewStatusId, doneStatusId };
}

async function statusNameOf(db: TestDb, issueId: string): Promise<string> {
  const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
  const [status] = await db
    .select({ name: projectStatuses.name })
    .from(projectStatuses)
    .where(eq(projectStatuses.id, issue.statusId));
  return status.name;
}

async function workspaceStatusOf(db: TestDb, workspaceId: string): Promise<string> {
  const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return ws.status;
}

describe("#380 silently-merged compensator runs off a restart", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  afterEach(() => {
    stopAncestorBranchReconciler();
    vi.useRealTimers();
  });

  it("converges a stranded merged workspace's issue to Done with no restart", async () => {
    const { issueId, workspaceId } = await seedStrandedMergedWorkspace(db);

    // Precondition: this is the stalled state, not an already-healthy one. Without it the
    // assertion below could pass on a seed that was never broken.
    expect(await statusNameOf(db, issueId)).toBe("In Review");
    expect(await workspaceStatusOf(db, workspaceId)).toBe("idle");

    await runSilentlyMergedCompensatorTick(db);

    expect(await statusNameOf(db, issueId)).toBe("Done");
    expect(await workspaceStatusOf(db, workspaceId)).toBe("closed");
  });

  it("is idempotent — a second tick does not rewrite statusChangedAt", async () => {
    const { issueId } = await seedStrandedMergedWorkspace(db);

    await runSilentlyMergedCompensatorTick(db);
    const [afterFirst] = await db
      .select({ statusChangedAt: issues.statusChangedAt })
      .from(issues)
      .where(eq(issues.id, issueId));

    await runSilentlyMergedCompensatorTick(db);
    const [afterSecond] = await db
      .select({ statusChangedAt: issues.statusChangedAt })
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(await statusNameOf(db, issueId)).toBe("Done");
    expect(afterSecond.statusChangedAt).toBe(afterFirst.statusChangedAt);
  });

  /**
   * The wiring test. This is the one that fails if the
   * `void runSilentlyMergedCompensatorTick(deps.database)` line is deleted from
   * `startAncestorBranchReconciler`'s default tick — i.e. if the fix is reverted while the
   * helper itself stays perfectly functional and its own unit tests stay green.
   */
  it("is invoked by the ancestor reconciler's periodic tick (regression guard for the wiring)", async () => {
    const { issueId } = await seedStrandedMergedWorkspace(db);
    vi.useFakeTimers();

    startAncestorBranchReconciler({ database: db }, 5 * 60_000);

    // The reconciler's first run is a 35s post-boot timeout; advance past it.
    await vi.advanceTimersByTimeAsync(40_000);
    // The tick fires the compensator as a floating promise that awaits a dynamic import and
    // several DB round-trips. Let the microtask queue drain on the real clock.
    vi.useRealTimers();
    for (let i = 0; i < 50 && (await statusNameOf(db, issueId)) !== "Done"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(await statusNameOf(db, issueId)).toBe("Done");
  });
});
