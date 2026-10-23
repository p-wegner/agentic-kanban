import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mergeTrains, projects } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMergeTrain, getMergeTrain, updateMergeTrainState } from "../repositories/merge-train.repository.js";
import { reconcileStrandedMergeTrains, STALLED_LIVE_TRAIN_MS, HUNG_GATE_CEILING_MS } from "../startup/merge-train-reconciler.js";
import {
  isMergeTrainLive,
  describeLiveGate,
  noteMergeTrainGateResultReceived,
  noteMergeTrainGateProgress,
  isMergeTrainStalled,
  noteMergeTrainGateActivity,
  registerLiveMergeTrain,
  resetLiveMergeTrainRegistryForTests,
  snapshotLiveMergeTrains,
} from "../services/merge-train-live-registry.js";

import { decideAgeAbandonSplit, GATE_AGE_ABANDON_MARKER } from "../services/merge-train-age-split.js";

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

  it("leaves a train alone while a gate is running within the ceiling", async () => {
    const { db } = createTestDb();
    const { trainId } = await seedGating(db);
    registerLiveMergeTrain({ trainId, label: "train/stalled-01", projectId: (await getMergeTrain(trainId, db))!.projectId, nowMs: NOW - 2 * STALLED_LIVE_TRAIN_MS });
    noteMergeTrainGateActivity(trainId, true, NOW - 2 * STALLED_LIVE_TRAIN_MS);
    const result = await reconcileStrandedMergeTrains({ database: db, now: new Date(NOW).toISOString(), log: () => undefined, liveTrains: snapshotLiveMergeTrains() });
    expect(result.skippedLive).toEqual([trainId]);
    expect((await getMergeTrain(trainId, db))?.state).toBe("gating");
  });
});

describe("hung gate (#1646)", () => {
  it("abandons a train whose gate is active past the ceiling, naming the hung gate", async () => {
    const { db } = createTestDb();
    const { trainId } = await seedGating(db);
    const projectId = (await getMergeTrain(trainId, db))!.projectId;
    registerLiveMergeTrain({ trainId, label: "train/stalled-01", projectId, nowMs: NOW - 2 * HUNG_GATE_CEILING_MS });
    noteMergeTrainGateActivity(trainId, true, NOW - 2 * HUNG_GATE_CEILING_MS);
    noteMergeTrainGateResultReceived(projectId, NOW - 2 * HUNG_GATE_CEILING_MS + 1000);
    expect(describeLiveGate(trainId, NOW)?.state).toBe("result-received-not-resumed");
    const result = await reconcileStrandedMergeTrains({ database: db, now: new Date(NOW).toISOString(), log: () => undefined, liveTrains: snapshotLiveMergeTrains() });
    expect(result.abandoned).toEqual([trainId]);
    const reason = (await getMergeTrain(trainId, db))?.reconciledReason ?? "";
    expect(reason).toContain("gate hung");
    expect(reason).toContain("never resumed");
  });

  it("#1679: does not abandon a 120m gate whose progress advanced 5m ago", async () => {
    const { db } = createTestDb();
    const { trainId } = await seedGating(db);
    const projectId = (await getMergeTrain(trainId, db))!.projectId;
    registerLiveMergeTrain({ trainId, label: "train/stalled-01", projectId, nowMs: NOW - 120 * 60_000 });
    noteMergeTrainGateActivity(trainId, true, NOW - 120 * 60_000);
    noteMergeTrainGateProgress(projectId, NOW - 5 * 60_000);
    const result = await reconcileStrandedMergeTrains({ database: db, now: new Date(NOW).toISOString(), log: () => undefined, liveTrains: snapshotLiveMergeTrains() });
    expect(result.abandoned).toEqual([]);
    expect((await getMergeTrain(trainId, db))?.state).toBe("gating");
  });

  it("#1679: abandons a gate with no progress for 20m, naming the idle time", async () => {
    const { db } = createTestDb();
    const { trainId } = await seedGating(db);
    const projectId = (await getMergeTrain(trainId, db))!.projectId;
    registerLiveMergeTrain({ trainId, label: "train/stalled-01", projectId, nowMs: NOW - 40 * 60_000 });
    noteMergeTrainGateActivity(trainId, true, NOW - 40 * 60_000);
    noteMergeTrainGateProgress(projectId, NOW - 20 * 60_000);
    const result = await reconcileStrandedMergeTrains({ database: db, now: new Date(NOW).toISOString(), log: () => undefined, liveTrains: snapshotLiveMergeTrains() });
    expect(result.abandoned).toEqual([trainId]);
    expect((await getMergeTrain(trainId, db))?.reconciledReason).toContain("no progress for 20m");
  });

  it("#1679: an age-ceiling abandon is marked so the next window splits", async () => {
    const { db } = createTestDb();
    const { trainId } = await seedGating(db);
    const projectId = (await getMergeTrain(trainId, db))!.projectId;
    registerLiveMergeTrain({ trainId, label: "train/stalled-01", projectId, nowMs: NOW - 2 * HUNG_GATE_CEILING_MS });
    noteMergeTrainGateActivity(trainId, true, NOW - 2 * HUNG_GATE_CEILING_MS);
    await reconcileStrandedMergeTrains({ database: db, now: new Date(NOW).toISOString(), log: () => undefined, liveTrains: snapshotLiveMergeTrains() });
    expect((await getMergeTrain(trainId, db))?.reconciledReason).toContain(GATE_AGE_ABANDON_MARKER);
  });
});

describe("decideAgeAbandonSplit (#1679)", () => {
  const aged = { state: "abandoned" as const, reconciledReason: `stalled: gate hung (${GATE_AGE_ABANDON_MARKER})`, memberWorkspaceIds: JSON.stringify(["a", "b", "c", "d"]) };
  it("splits an identical member set in half", () => {
    const d = decideAgeAbandonSplit(["a", "b", "c", "d"], [aged]);
    expect(d).toMatchObject({ action: "split", members: ["a", "b"], deferred: ["c", "d"] });
  });
  it("escalates a single member to land-local --on-worker", () => {
    const d = decideAgeAbandonSplit(["a"], [aged]);
    expect(d.action).toBe("escalate");
    expect((d as { reason: string }).reason).toContain("land-local --on-worker");
  });
  it("leaves other abandon reasons and unrelated members alone", () => {
    expect(decideAgeAbandonSplit(["a", "b"], [{ ...aged, reconciledReason: "stalled: gate hung - no progress" }]).action).toBe("none");
    expect(decideAgeAbandonSplit(["a", "z"], [aged]).action).toBe("none");
  });
});
