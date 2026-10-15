import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mergeTrains, projects } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMergeTrain, getMergeTrain, updateMergeTrainState } from "../repositories/merge-train.repository.js";
import { reconcileStrandedMergeTrains, STALLED_LIVE_TRAIN_MS } from "../startup/merge-train-reconciler.js";
import {
  isMergeTrainLive,
  isMergeTrainStalled,
  noteMergeTrainGateActivity,
  registerLiveMergeTrain,
  resetLiveMergeTrainRegistryForTests,
  snapshotLiveMergeTrains,
} from "../services/merge-train-live-registry.js";

/**
 * #1513 — a train whose fix agent ended red sat `gating` with a registered live job and nothing
 * running. The sweep skipped it as "live in this process" forever; it must abandon it instead.
 */

const NOW = Date.now();

async function seedGating(db: TestDb): Promise<{ trainId: string }> {
  const projectId = randomUUID();
  const iso = new Date(NOW).toISOString();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: "/tmp/p", repoName: "p", defaultBranch: "main", createdAt: iso, updatedAt: iso });
  const trainId = randomUUID();
  await createMergeTrain({ id: trainId, projectId, label: "train/stalled-01", memberWorkspaceIds: ["ws-1"] }, db);
  await updateMergeTrainState(trainId, { state: "gating" }, db);
  await db.update(mergeTrains).set({ startedAt: new Date(NOW - 3 * STALLED_LIVE_TRAIN_MS).toISOString() }).where(eq(mergeTrains.id, trainId));
  return { trainId };
}

afterEach(() => resetLiveMergeTrainRegistryForTests());

describe("isMergeTrainStalled", () => {
  it("needs no active gate AND a long idle gap", () => {
    expect(isMergeTrainStalled({ activeGates: 0, lastActivityMs: NOW - STALLED_LIVE_TRAIN_MS }, NOW, STALLED_LIVE_TRAIN_MS)).toBe(true);
    expect(isMergeTrainStalled({ activeGates: 1, lastActivityMs: NOW - 10 * STALLED_LIVE_TRAIN_MS }, NOW, STALLED_LIVE_TRAIN_MS)).toBe(false);
    expect(isMergeTrainStalled({ activeGates: 0, lastActivityMs: NOW - 1000 }, NOW, STALLED_LIVE_TRAIN_MS)).toBe(false);
  });
});

describe("reconcileStrandedMergeTrains - stalled live train (#1513)", () => {
  it("abandons a registered train that has had no gate running for the stall window", async () => {
    const { db } = createTestDb();
    const { trainId } = await seedGating(db);
    registerLiveMergeTrain({ trainId, label: "train/stalled-01", projectId: (await getMergeTrain(trainId, db))!.projectId, nowMs: NOW - 2 * STALLED_LIVE_TRAIN_MS });
    const result = await reconcileStrandedMergeTrains({ database: db, now: new Date(NOW).toISOString(), log: () => undefined, liveTrains: snapshotLiveMergeTrains() });
    expect(result.abandoned).toEqual([trainId]);
    expect((await getMergeTrain(trainId, db))?.state).toBe("abandoned");
    expect((await getMergeTrain(trainId, db))?.reconciledReason).toContain("stalled");
    expect(isMergeTrainLive(trainId)).toBe(false);
  });

  it("leaves a train alone while a gate is running, however old", async () => {
    const { db } = createTestDb();
    const { trainId } = await seedGating(db);
    registerLiveMergeTrain({ trainId, label: "train/stalled-01", projectId: (await getMergeTrain(trainId, db))!.projectId, nowMs: NOW - 2 * STALLED_LIVE_TRAIN_MS });
    noteMergeTrainGateActivity(trainId, true, NOW - 2 * STALLED_LIVE_TRAIN_MS);
    const result = await reconcileStrandedMergeTrains({ database: db, now: new Date(NOW).toISOString(), log: () => undefined, liveTrains: snapshotLiveMergeTrains() });
    expect(result.skippedLive).toEqual([trainId]);
    expect((await getMergeTrain(trainId, db))?.state).toBe("gating");
  });
});
