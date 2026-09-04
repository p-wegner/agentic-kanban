import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as schema from "@agentic-kanban/shared/schema";
import { HARNESS_TAG, DEFAULT_HARNESS_SHARE_PCT } from "@agentic-kanban/shared/lib/harness-budget";
import { createTestDb } from "./helpers/test-db.js";
import { seedIssue, seedProject, seedWorkspace } from "./helpers/workflow-test-helpers.js";
import { buildHarnessBudgetGate } from "../startup/monitor-harness-budget.js";
import { readHarnessShare } from "../repositories/harness-tag.repository.js";

/**
 * #1021, proposal §3.E — the harness budget as the auto-start pull loop applies it.
 *
 * The acceptance criterion is stated in builders, not percent: with three `harness` tickets
 * at the top of the backlog and WIP 3, at most ONE starts and the others are held with
 * `harness_budget`; at 100 % all three start (today's behaviour). Both are asserted here
 * against a real database, driving the same gate `runTodoPull` drives.
 */
describe("harness budget gate (#1021)", () => {
  async function tag(db: Awaited<ReturnType<typeof createTestDb>>["db"], issueId: string, name: string) {
    const rows = await db.select().from(schema.tags);
    let tagId = rows.find((t) => t.name === name)?.id;
    if (!tagId) {
      tagId = randomUUID();
      await db.insert(schema.tags).values({ id: tagId, name, isBuiltin: false, createdAt: new Date().toISOString() });
    }
    await db.insert(schema.issueTags).values({ id: randomUUID(), issueId, tagId });
  }

  /** Three harness tickets in Todo, nothing running — the ticket's acceptance scenario. */
  async function seedThreeHarnessCandidates() {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db, "harness-budget");
    const ids: string[] = [];
    for (const n of [101, 102, 103]) {
      const id = await seedIssue(db, projectId, statusIds["Todo"], n, `Harness ticket ${n}`);
      await tag(db, id, HARNESS_TAG);
      ids.push(id);
    }
    return { db, projectId, statusIds, ids };
  }

  /**
   * The gate answers per candidate and is fed each launch back, exactly as `runTodoPull`
   * does — so this walks the candidate list the way the cycle does and reports which
   * tickets started and which were held.
   */
  function runPull(gate: Awaited<ReturnType<typeof buildHarnessBudgetGate>>, ids: string[]) {
    const started: string[] = [];
    const held: string[] = [];
    for (const id of ids) {
      if (!gate.allows(id)) { held.push(id); continue; }
      started.push(id);
      gate.noteStarted(id);
    }
    return { started, held };
  }

  it("three harness tickets, WIP 3 — one starts, two are held for harness_budget", async () => {
    const { db, statusIds, ids } = await seedThreeHarnessCandidates();
    const gate = await buildHarnessBudgetGate({
      database: db,
      inProgressStatusId: statusIds["In Progress"],
      wipLimit: 3,
      sharePct: DEFAULT_HARNESS_SHARE_PCT,
      candidateIssueIds: ids,
    });

    expect(gate.slots).toBe(1);
    const { started, held } = runPull(gate, ids);
    expect(started).toEqual([ids[0]]);
    expect(held).toEqual([ids[1], ids[2]]);
  });

  it("the same three at 100 % share all start — the documented way back to pre-#1021 behaviour", async () => {
    const { db, statusIds, ids } = await seedThreeHarnessCandidates();
    const gate = await buildHarnessBudgetGate({
      database: db,
      inProgressStatusId: statusIds["In Progress"],
      wipLimit: 3,
      sharePct: 100,
      candidateIssueIds: ids,
    });

    const { started, held } = runPull(gate, ids);
    expect(started).toEqual(ids);
    expect(held).toEqual([]);
  });

  it("a harness builder ALREADY running consumes the slot, so nothing new starts", async () => {
    // The budget is a share of the WIP, not a per-cycle allowance — a cycle that ignored
    // what is already running would let the share drift up one builder per cycle.
    const { db, projectId, statusIds, ids } = await seedThreeHarnessCandidates();
    const runningId = await seedIssue(db, projectId, statusIds["In Progress"], 100, "Already-running harness ticket");
    await tag(db, runningId, HARNESS_TAG);
    await seedWorkspace(db, runningId, "feature/ak-100", null);

    const gate = await buildHarnessBudgetGate({
      database: db,
      inProgressStatusId: statusIds["In Progress"],
      wipLimit: 3,
      sharePct: DEFAULT_HARNESS_SHARE_PCT,
      candidateIssueIds: ids,
    });

    expect(gate.slots).toBe(1);
    expect(gate.used).toBe(1);
    expect(runPull(gate, ids).started).toEqual([]);
  });

  it("never holds a PRODUCT ticket — the budget shifts concurrency, it does not reduce it", async () => {
    const { db, projectId, statusIds, ids } = await seedThreeHarnessCandidates();
    const productId = await seedIssue(db, projectId, statusIds["Todo"], 104, "Show tags on the card");

    const gate = await buildHarnessBudgetGate({
      database: db,
      inProgressStatusId: statusIds["In Progress"],
      wipLimit: 3,
      sharePct: DEFAULT_HARNESS_SHARE_PCT,
      candidateIssueIds: [...ids, productId],
    });

    const { started, held } = runPull(gate, [...ids, productId]);
    expect(started).toEqual([ids[0], productId]);
    expect(held).toEqual([ids[1], ids[2]]);
    expect(gate.isHarness(productId)).toBe(false);
  });

  it("an untagged backlog is not gated at all", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db, "no-harness");
    const a = await seedIssue(db, projectId, statusIds["Todo"], 1, "Product A");
    const b = await seedIssue(db, projectId, statusIds["Todo"], 2, "Product B");

    const gate = await buildHarnessBudgetGate({
      database: db,
      inProgressStatusId: statusIds["In Progress"],
      wipLimit: 1,
      sharePct: DEFAULT_HARNESS_SHARE_PCT,
      candidateIssueIds: [a, b],
    });
    expect(runPull(gate, [a, b]).held).toEqual([]);
  });
});

describe("harness share read-off (#1021)", () => {
  it("reports the share of tickets Done in the last 7 days that carried the tag", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db, "harness-share");
    const now = Date.parse("2026-09-04T12:00:00.000Z");
    const recently = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const longAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    const harnessTagId = randomUUID();
    await db.insert(schema.tags).values({ id: harnessTagId, name: HARNESS_TAG, isBuiltin: false, createdAt: recently });
    const addTag = async (issueId: string) =>
      db.insert(schema.issueTags).values({ id: randomUUID(), issueId, tagId: harnessTagId });

    // 4 Done this week, 1 of them harness → 25 %.
    const h = await seedIssue(db, projectId, statusIds["Done"], 1, "Ratchet", { statusChangedAt: recently });
    await addTag(h);
    for (const n of [2, 3, 4]) {
      await seedIssue(db, projectId, statusIds["Done"], n, `Product ${n}`, { statusChangedAt: recently });
    }
    // Outside the window, and a harness one at that — it must not move the number.
    const old = await seedIssue(db, projectId, statusIds["Done"], 5, "Old ratchet", { statusChangedAt: longAgo });
    await addTag(old);
    // Not Done — in flight is not shipped.
    await seedIssue(db, projectId, statusIds["Todo"], 6, "Pending", { statusChangedAt: recently });

    const snapshot = await readHarnessShare(db, now);
    expect(snapshot.doneCount).toBe(4);
    expect(snapshot.harnessCount).toBe(1);
    expect(snapshot.sharePct).toBe(25);
    expect(snapshot.windowDays).toBe(7);
  });

  it("an empty week reports null, not 0 % — nothing measured is not a budget respected", async () => {
    const { db } = createTestDb();
    await seedProject(db, "quiet-week");
    const snapshot = await readHarnessShare(db, Date.parse("2026-09-04T12:00:00.000Z"));
    expect(snapshot.doneCount).toBe(0);
    expect(snapshot.sharePct).toBeNull();
  });
});
