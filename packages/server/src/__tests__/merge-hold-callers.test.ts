/**
 * #1164 — a per-workspace merge HOLD, and the three callers it must be honored by: the monitor
 * walk (`canStartMerge` in `monitor-cycle.ts`), the auto-merge orchestrator's candidate filter,
 * and the merge-train reconciler's stranded-train sweep. A held workspace is skipped by all
 * three, and resumes being eligible the moment the hold is released.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import {
  clearMergeHold,
  getHeldWorkspaceIds,
  getHeldWorkspaceIdsAmong,
  getMergeHold,
  setMergeHold,
} from "../repositories/merge-hold.repository.js";
import {
  decideMergeTrainReconcileAction,
  reconcileStrandedMergeTrains,
} from "../startup/merge-train-reconciler.js";
import { createMergeTrain } from "../repositories/merge-train.repository.js";

const T0 = "2026-09-15T00:00:00.000Z";

async function seedWorkspace(db: TestDb, opts: { branch: string }): Promise<{ workspaceId: string; projectId: string }> {
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: T0, updatedAt: T0,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: T0,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 1, title: "Issue 1", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: T0, updatedAt: T0,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: opts.branch, workingDir: "/repo/.worktrees/ws",
    baseBranch: "master", status: "idle", provider: "claude", createdAt: T0, updatedAt: T0,
  });
  return { workspaceId, projectId };
}

describe("merge-hold.repository (#1164)", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let db: TestDb;

  beforeEach(() => {
    ctx = createTestDb();
    db = ctx.db;
  });
  afterEach(() => ctx.dispose());

  it("no row means not held", async () => {
    const { workspaceId } = await seedWorkspace(db, { branch: "feature/a" });
    expect(await getMergeHold(workspaceId, db)).toBeUndefined();
    expect((await getHeldWorkspaceIds(db)).has(workspaceId)).toBe(false);
  });

  it("set then clear round-trips, and clear on a never-held workspace is a no-op", async () => {
    const { workspaceId } = await seedWorkspace(db, { branch: "feature/a" });
    await setMergeHold(workspaceId, { reason: "red gate", heldAt: T0 }, db);
    const held = await getMergeHold(workspaceId, db);
    expect(held?.reason).toBe("red gate");
    expect((await getHeldWorkspaceIds(db)).has(workspaceId)).toBe(true);

    await clearMergeHold(workspaceId, db);
    expect(await getMergeHold(workspaceId, db)).toBeUndefined();
    // Idempotent — releasing again is not an error.
    await expect(clearMergeHold(workspaceId, db)).resolves.toBeUndefined();
  });

  it("re-holding an already-held workspace updates the reason (upsert, not a duplicate row)", async () => {
    const { workspaceId } = await seedWorkspace(db, { branch: "feature/a" });
    await setMergeHold(workspaceId, { reason: "first reason", heldAt: T0 }, db);
    await setMergeHold(workspaceId, { reason: "second reason", heldAt: "2026-09-15T01:00:00.000Z" }, db);
    const held = await getMergeHold(workspaceId, db);
    expect(held?.reason).toBe("second reason");
  });

  it("getHeldWorkspaceIdsAmong narrows to only the given ids, and handles an empty list", async () => {
    const a = await seedWorkspace(db, { branch: "feature/a" });
    const b = await seedWorkspace(db, { branch: "feature/b" });
    await setMergeHold(a.workspaceId, { reason: null, heldAt: T0 }, db);

    const among = await getHeldWorkspaceIdsAmong([a.workspaceId, b.workspaceId], db);
    expect(among.has(a.workspaceId)).toBe(true);
    expect(among.has(b.workspaceId)).toBe(false);
    expect(await getHeldWorkspaceIdsAmong([], db)).toEqual(new Set());
  });
});

// The monitor-walk assertion lives in its own file (`merge-hold-monitor-walk.test.ts`) — it
// needs `vi.mock("../db/index.js")` at module scope (hoisted by vitest), which would break this
// file's real-DB `createTestDb()` suites above if both lived in one file.

describe("merge-train reconciler honors a merge hold (#1164)", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let db: TestDb;

  beforeEach(() => {
    ctx = createTestDb();
    db = ctx.db;
  });
  afterEach(() => ctx.dispose());

  it("skips (neither resumes nor abandons) a stranded train with a held member", async () => {
    const a = await seedWorkspace(db, { branch: "feature/a" });
    const b = await seedWorkspace(db, { branch: "feature/b" });
    await setMergeHold(a.workspaceId, { reason: "red gate", heldAt: T0 }, db);

    await createMergeTrain(
      { id: "train-1", projectId: a.projectId, label: "q1", memberWorkspaceIds: [a.workspaceId, b.workspaceId] },
      db,
    );

    let ran = false;
    const result = await reconcileStrandedMergeTrains({
      database: db,
      runTrain: async () => { ran = true; },
    });

    expect(ran).toBe(false);
    expect(result.resumed).toEqual([]);
    expect(result.abandoned).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("resumes a stranded train once its held member is released", async () => {
    const a = await seedWorkspace(db, { branch: "feature/a" });
    await setMergeHold(a.workspaceId, { reason: "red gate", heldAt: T0 }, db);
    await createMergeTrain(
      { id: "train-2", projectId: a.projectId, label: "q1", memberWorkspaceIds: [a.workspaceId] },
      db,
    );

    let ran = false;
    await reconcileStrandedMergeTrains({ database: db, runTrain: async () => { ran = true; } });
    expect(ran).toBe(false);

    await clearMergeHold(a.workspaceId, db);
    await reconcileStrandedMergeTrains({ database: db, runTrain: async () => { ran = true; } });
    expect(ran).toBe(true);
  });

  it("decideMergeTrainReconcileAction itself is unaware of holds — the skip happens in the sweep loop, not the pure decision", () => {
    const { action } = decideMergeTrainReconcileAction({ reconciledReason: null });
    expect(action).toBe("resume");
  });
});
