import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { mergeTrains, projects } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import {
  createMergeTrain,
  getMergeTrain,
  updateMergeTrainState,
  type MergeTrainRow,
} from "../repositories/merge-train.repository.js";
import { reconcileStrandedMergeTrains } from "../startup/merge-train-reconciler.js";

/**
 * #1183 — after a real restart with TWO stranded `assembling`/`gating` rows for the SAME
 * project, the boot pass used to resume the first row's `runTrain`, which abandoned that row
 * and re-entered `beginMergeTrain` — which refuses (`already_in_flight`) whenever ANY other
 * assembling/gating row exists for the project. The second stranded row (not yet processed)
 * always satisfied that refusal, so the first row's members were dropped for that pass and
 * only picked up again on a later window close.
 *
 * Fix: coalesce every stranded row of one project into ONE resume (union of members) before
 * `runTrain` is ever invoked — so `beginMergeTrain`'s project-wide check sees at most one
 * lingering row (the one being resumed) rather than a still-untouched sibling.
 */

const T0 = Date.parse("2026-09-17T10:00:00.000Z");
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

async function seedGatingTrain(db: TestDb, projectId: string, label: string, memberWorkspaceIds: string[]): Promise<MergeTrainRow> {
  const id = randomUUID();
  await createMergeTrain({ id, projectId, label, memberWorkspaceIds }, db);
  await updateMergeTrainState(id, { state: "gating" }, db);
  await db.update(mergeTrains).set({ startedAt: iso(T0) }).where(eq(mergeTrains.id, id));
  const row = await getMergeTrain(id, db);
  if (!row) throw new Error("seed failed");
  return row;
}

describe("reconcileStrandedMergeTrains coalescing (#1183)", () => {
  it("resumes two stranded rows for one project as ONE coalesced train with the union of members, no refusal", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const rowA = await seedGatingTrain(db, projectId, "qa", ["ws-1", "ws-2"]);
    const rowB = await seedGatingTrain(db, projectId, "qb", ["ws-3"]);

    const seenMemberSets: string[][] = [];
    const result = await reconcileStrandedMergeTrains({
      database: db,
      now: iso(T0 + 60_000),
      liveTrains: new Map(),
      log: () => {},
      runTrain: async (row) => {
        seenMemberSets.push(JSON.parse(row.memberWorkspaceIds) as string[]);
      },
    });

    // Exactly one runTrain invocation for the project, carrying every member from both rows.
    expect(seenMemberSets).toEqual([["ws-1", "ws-2", "ws-3"]]);

    // Both rows are accounted for as resumed — neither silently dropped.
    expect(new Set(result.resumed)).toEqual(new Set([rowA.id, rowB.id]));
    expect(result.abandoned).toEqual([]);

    // The non-lead row is abandoned as superseded (coalesced), never left dangling as
    // assembling/gating — which is exactly what would trip `beginMergeTrain`'s in-flight check.
    const afterB = await getMergeTrain(rowB.id, db);
    expect(afterB?.state).toBe("abandoned");
    expect(afterB?.reconciledReason).toContain("coalesced into a single resume");
  });

  it("leaves an unrelated project's stranded row untouched by the coalescing", async () => {
    const { db } = createTestDb();
    const projectA = await seedProject(db);
    const projectB = await seedProject(db);
    const rowA1 = await seedGatingTrain(db, projectA, "qa1", ["ws-1"]);
    const rowA2 = await seedGatingTrain(db, projectA, "qa2", ["ws-2"]);
    const rowB = await seedGatingTrain(db, projectB, "qb", ["ws-9"]);

    const runs: { projectId: string; members: string[] }[] = [];
    const result = await reconcileStrandedMergeTrains({
      database: db,
      now: iso(T0 + 60_000),
      liveTrains: new Map(),
      log: () => {},
      runTrain: async (row) => {
        runs.push({ projectId: row.projectId, members: JSON.parse(row.memberWorkspaceIds) as string[] });
      },
    });

    expect(runs).toHaveLength(2);
    const forA = runs.find((r) => r.projectId === projectA);
    const forB = runs.find((r) => r.projectId === projectB);
    expect(forA?.members).toEqual(["ws-1", "ws-2"]);
    expect(forB?.members).toEqual(["ws-9"]);
    expect(new Set(result.resumed)).toEqual(new Set([rowA1.id, rowA2.id, rowB.id]));
  });

  it("a row with exhausted resume attempts still abandons individually rather than being coalesced", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const exhausted = await seedGatingTrain(db, projectId, "qexhausted", ["ws-1"]);
    await updateMergeTrainState(exhausted.id, { state: "gating", reconciledReason: "resume attempt 2: retrying" }, db);
    const fresh = await seedGatingTrain(db, projectId, "qfresh", ["ws-2"]);

    const seenMemberSets: string[][] = [];
    const result = await reconcileStrandedMergeTrains({
      database: db,
      now: iso(T0 + 60_000),
      liveTrains: new Map(),
      log: () => {},
      runTrain: async (row) => {
        seenMemberSets.push(JSON.parse(row.memberWorkspaceIds) as string[]);
      },
    });

    // The exhausted row abandons on its own terms — not folded into the fresh row's resume.
    expect(seenMemberSets).toEqual([["ws-2"]]);
    expect(result.abandoned).toEqual([exhausted.id]);
    expect(result.resumed).toEqual([fresh.id]);
    const afterExhausted = await getMergeTrain(exhausted.id, db);
    expect(afterExhausted?.reconciledReason).toContain("giving up rather than retrying indefinitely");
  });

  it("when the coalesced resume fails, both the lead and the superseded siblings are abandoned and accounted for", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const rowA = await seedGatingTrain(db, projectId, "qa", ["ws-1"]);
    const rowB = await seedGatingTrain(db, projectId, "qb", ["ws-2"]);

    const result = await reconcileStrandedMergeTrains({
      database: db,
      now: iso(T0 + 60_000),
      liveTrains: new Map(),
      log: () => {},
      runTrain: async () => {
        throw new Error("boom");
      },
    });

    expect(new Set(result.abandoned)).toEqual(new Set([rowA.id, rowB.id]));
    expect(result.resumed).toEqual([]);
    const afterA = await getMergeTrain(rowA.id, db);
    expect(afterA?.reconciledReason).toContain("resume attempt 1 failed: boom");
    const afterB = await getMergeTrain(rowB.id, db);
    expect(afterB?.state).toBe("abandoned");
    expect(afterB?.reconciledReason).toContain("coalesced into a single resume");
  });
});
