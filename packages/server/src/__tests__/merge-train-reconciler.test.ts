import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { projects } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMergeTrain, getMergeTrain, updateMergeTrainState } from "../repositories/merge-train.repository.js";
import { reconcileStrandedMergeTrains } from "../startup/merge-train-reconciler.js";
import {
  registerLiveMergeTrain,
  resetLiveMergeTrainRegistry,
  unregisterLiveMergeTrain,
} from "../services/merge-train-live-registry.js";

async function seedProject(db: TestDb): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Test Project",
    repoPath: `/tmp/${projectId}`,
    repoName: "repo",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return projectId;
}

/**
 * #1181 — the periodic sweep (every `SWEEP_INTERVAL_MS`, distinct from the boot-delay pass)
 * used to reason "found at server boot" about every `assembling`/`gating` row regardless of
 * which pass found it, so a train still gating 8 minutes into a real run was abandoned as
 * "superseded" and a fresh, competing train assembled for the same members — which then died
 * on the repo lock the still-running original held. These pin the fix: a periodic tick must
 * leave a row alone when this process has a live job for it registered, and only the boot pass
 * may still treat every row as orphaned by construction.
 */
describe("merge train reconciler — live-job registry (#1181)", () => {
  afterEach(() => {
    resetLiveMergeTrainRegistry();
  });

  it("a periodic sweep SKIPS a gating row with a registered live job, rather than abandoning/resuming it", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const trainId = randomUUID();
    await createMergeTrain({ id: trainId, projectId, label: "qlive", memberWorkspaceIds: ["ws-1"] }, db);
    await updateMergeTrainState(trainId, { state: "gating" }, db);

    registerLiveMergeTrain(trainId);

    const runTrain = async () => {
      throw new Error("must not be called for a live row");
    };
    const result = await reconcileStrandedMergeTrains({
      database: db,
      isBootPass: false,
      runTrain,
    });

    expect(result.resumed).toEqual([]);
    expect(result.abandoned).toEqual([]);
    expect(result.skipped).toBe(1);

    const row = await getMergeTrain(trainId, db);
    expect(row?.state).toBe("gating");
  });

  it("the SAME row, after a simulated restart (empty registry), is resumed as before", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const trainId = randomUUID();
    await createMergeTrain({ id: trainId, projectId, label: "qrestart", memberWorkspaceIds: ["ws-1"] }, db);
    await updateMergeTrainState(trainId, { state: "gating" }, db);

    // Registry is empty by construction — simulates a fresh process, i.e. a boot pass.
    let called = false;
    const result = await reconcileStrandedMergeTrains({
      database: db,
      isBootPass: false,
      runTrain: async () => {
        called = true;
      },
    });

    expect(called).toBe(true);
    expect(result.resumed).toEqual([trainId]);
    expect(result.skipped).toBe(0);
  });

  it("a boot pass still treats every row as orphaned even if (implausibly) registered as live", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const trainId = randomUUID();
    await createMergeTrain({ id: trainId, projectId, label: "qboot", memberWorkspaceIds: ["ws-1"] }, db);
    await updateMergeTrainState(trainId, { state: "gating" }, db);

    registerLiveMergeTrain(trainId);
    let called = false;
    const result = await reconcileStrandedMergeTrains({
      database: db,
      isBootPass: true,
      runTrain: async () => {
        called = true;
      },
    });

    expect(called).toBe(true);
    expect(result.resumed).toEqual([trainId]);
    unregisterLiveMergeTrain(trainId);
  });
});
