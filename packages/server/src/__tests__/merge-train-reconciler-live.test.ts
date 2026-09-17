import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mergeTrains, projects } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import {
  createMergeTrain,
  getMergeTrain,
  updateMergeTrainState,
  type MergeTrainRow,
} from "../repositories/merge-train.repository.js";
import {
  decideMergeTrainLiveSkip,
  decideMergeTrainReconcileAction,
  reconcileStrandedMergeTrains,
} from "../startup/merge-train-reconciler.js";
import {
  registerLiveMergeTrain,
  resetLiveMergeTrainRegistryForTests,
  snapshotLiveMergeTrains,
  unregisterLiveMergeTrain,
  type LiveMergeTrainSnapshot,
} from "../services/merge-train-live-registry.js";

/**
 * #1181 — the reconciler's PERIODIC sweep applied its boot-time rule ("no live job can exist
 * for a row found at server boot") to rows that had a live job in the very same process.
 * Measured 2026-09-16: a 14-member train 8 minutes into its gate was abandoned as
 * "superseded", the re-assembled train then died waiting on the repo lock the live job still
 * held, and the cycle repeated every sweep. These tests pin the three verdicts the sweep must
 * now make: skip a registered row, skip a same-project sibling, and still resume when the
 * registry is empty (a fresh process — the boot pass).
 */

const T0 = Date.parse("2026-09-16T23:13:05.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

async function seedProject(db: TestDb): Promise<string> {
  const id = randomUUID();
  const now = iso(T0);
  await db.insert(projects).values({
    id, name: "p", repoPath: "/tmp/p", repoName: "p", defaultBranch: "main",
    createdAt: now, updatedAt: now,
  });
  return id;
}

/** A `gating` row that started at T0 — the shape the live incident had. */
async function seedGatingTrain(db: TestDb, projectId: string, label: string): Promise<MergeTrainRow> {
  const id = randomUUID();
  await createMergeTrain({ id, projectId, label, memberWorkspaceIds: ["ws-1", "ws-2"] }, db);
  await updateMergeTrainState(id, { state: "gating" }, db);
  // Pin the start to T0 — the sweep's "age Nm" is computed from the ROW's startedAt.
  await db.update(mergeTrains).set({ startedAt: iso(T0) }).where(eq(mergeTrains.id, id));
  const row = await getMergeTrain(id, db);
  if (!row) throw new Error("seed failed");
  return row;
}

afterEach(() => {
  resetLiveMergeTrainRegistryForTests();
});

describe("decideMergeTrainLiveSkip (#1181) — pure", () => {
  const row = { id: "t1", projectId: "p1", startedAt: iso(T0) };

  it("returns null on an empty registry — the boot pass keeps its 'nothing can be live' rule", () => {
    expect(decideMergeTrainLiveSkip(row, new Map(), T0 + 8 * 60_000)).toBeNull();
  });

  it("skips a row whose own job is registered, naming its age", () => {
    const live: LiveMergeTrainSnapshot = new Map([["t1", { trainId: "t1", label: "q1", projectId: "p1", registeredAtMs: T0 }]]);
    expect(decideMergeTrainLiveSkip(row, live, T0 + 8 * 60_000)).toEqual({ reason: "live in this process (age 8m)" });
  });

  it("skips a row when ANOTHER train for the same project is live — a resume would mint a second one", () => {
    const live: LiveMergeTrainSnapshot = new Map([["t9", { trainId: "t9", label: "q9", projectId: "p1", registeredAtMs: T0 }]]);
    const skip = decideMergeTrainLiveSkip(row, live, T0 + 60_000);
    expect(skip?.reason).toContain("another train (t9, q9) for project p1 is live");
  });

  it("does not skip for a live train of a DIFFERENT project", () => {
    const live: LiveMergeTrainSnapshot = new Map([["t9", { trainId: "t9", label: "q9", projectId: "p2", registeredAtMs: T0 }]]);
    expect(decideMergeTrainLiveSkip(row, live, T0 + 60_000)).toBeNull();
  });

  it("the boot-rule decision is unchanged for a first-seen row", () => {
    expect(decideMergeTrainReconcileAction({ reconciledReason: null }).action).toBe("resume");
  });
});

describe("reconcileStrandedMergeTrains (#1181) — sweep vs the live registry", () => {
  it("(a) leaves a gating row younger than the sweep interval alone while its job is registered live", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const row = await seedGatingTrain(db, projectId, "qlive");
    registerLiveMergeTrain({ trainId: row.id, label: row.label, projectId, nowMs: T0 });

    const logs: string[] = [];
    let resumed = 0;
    const result = await reconcileStrandedMergeTrains({
      database: db,
      now: iso(T0 + 8 * 60_000),
      log: (m) => logs.push(m),
      runTrain: async () => { resumed++; },
    });

    expect(resumed).toBe(0);
    expect(result.skippedLive).toEqual([row.id]);
    expect(result.resumed).toEqual([]);
    expect(result.abandoned).toEqual([]);
    expect((await getMergeTrain(row.id, db))?.state).toBe("gating");
    expect(logs.some((l) => l.startsWith(`skipping train ${row.id}`) && l.includes("live in this process (age 8m)"))).toBe(true);
  });

  it("(b) resumes the same row when the registry is empty — a restarted process has no live jobs", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const row = await seedGatingTrain(db, projectId, "qorphan");
    // Simulate the restart: whatever was registered before is gone.
    unregisterLiveMergeTrain(row.id);
    expect(snapshotLiveMergeTrains().size).toBe(0);

    const seen: string[] = [];
    const result = await reconcileStrandedMergeTrains({
      database: db,
      now: iso(T0 + 8 * 60_000),
      log: () => {},
      runTrain: async (r) => { seen.push(r.id); },
    });

    expect(seen).toEqual([row.id]);
    expect(result.resumed).toEqual([row.id]);
    expect(result.skippedLive).toEqual([]);
    const after = await getMergeTrain(row.id, db);
    expect(after?.reconciledReason).toContain("resume attempt 1");
  });

  it("(c) skips a stranded row while a DIFFERENT train for the same project is live — never a second in-flight train per project", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const stranded = await seedGatingTrain(db, projectId, "qstranded");
    const live = await seedGatingTrain(db, projectId, "qrunning");
    registerLiveMergeTrain({ trainId: live.id, label: live.label, projectId, nowMs: T0 });

    let resumed = 0;
    const result = await reconcileStrandedMergeTrains({
      database: db,
      now: iso(T0 + 60_000),
      log: () => {},
      runTrain: async () => { resumed++; },
    });

    expect(resumed).toBe(0);
    expect(new Set(result.skippedLive)).toEqual(new Set([stranded.id, live.id]));
    expect((await getMergeTrain(stranded.id, db))?.state).toBe("gating");
    expect((await getMergeTrain(live.id, db))?.state).toBe("gating");
  });

  it("(a′) a row is never marked abandoned while registered live, even when it has exhausted its resume attempts", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const row = await seedGatingTrain(db, projectId, "qexhausted");
    await updateMergeTrainState(row.id, { state: "gating", reconciledReason: "resume attempt 2: retrying" }, db);
    registerLiveMergeTrain({ trainId: row.id, label: row.label, projectId, nowMs: T0 });

    const result = await reconcileStrandedMergeTrains({ database: db, now: iso(T0 + 60_000), log: () => {} });

    expect(result.abandoned).toEqual([]);
    expect(result.skippedLive).toEqual([row.id]);
    expect((await getMergeTrain(row.id, db))?.state).toBe("gating");
  });

  it("an explicit empty `liveTrains` snapshot overrides the process registry (the boot-pass simulation seam)", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const row = await seedGatingTrain(db, projectId, "qseam");
    registerLiveMergeTrain({ trainId: row.id, label: row.label, projectId, nowMs: T0 });

    const result = await reconcileStrandedMergeTrains({
      database: db,
      now: iso(T0 + 60_000),
      log: () => {},
      liveTrains: new Map(),
      runTrain: async () => {},
    });

    expect(result.resumed).toEqual([row.id]);
  });
});
