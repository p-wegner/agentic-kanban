// #1102 — the one-shot migration that retires `wip_limit_<projectId>` into the Strategy Bullseye.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { preferences, projects } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { resolveMonitorTunables } from "@agentic-kanban/shared/lib/strategy-objective-file";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { migrateWipLimitPrefsIntoBullseye, planWipLimitMigration } from "../services/wip-limit-migration.service.js";
import { resolveWipLimit } from "../services/wip-limit.service.js";

const P = "11111111-2222-3333-4444-555555555555";
const Q = "99999999-8888-7777-6666-555555555555";

const map = (entries: Record<string, string>) => new Map(Object.entries(entries));
const bullseye = (fields: Record<string, unknown>) => JSON.stringify(fields);

describe("planWipLimitMigration — the four cases (#1102)", () => {
  it("pref only: mints a Bullseye carrying the pref AND the legacy floor/start cap, then drops the pref", () => {
    const prefMap = map({ [`wip_limit_${P}`]: "2" });
    const before = resolveMonitorTunables(prefMap, P).tunables;
    const plan = planWipLimitMigration(prefMap, [P]);
    expect(plan.deletes).toEqual([{ projectId: P, key: `wip_limit_${P}`, reason: "pref_only" }]);
    expect(plan.writes).toHaveLength(1);
    const written = JSON.parse(plan.writes[0].value);
    expect(written.activeAgentsTarget).toBe(2);
    // Minting a Bullseye must not quietly move the two numbers nobody asked to change.
    const after = resolveMonitorTunables(map({ [`board_strategy_${P}`]: plan.writes[0].value }), P).tunables;
    expect(after.backlogFloor).toBe(before.backlogFloor);
    expect(after.maxNewStartsPerCycle).toBe(before.maxNewStartsPerCycle);
  });

  it("Bullseye only: nothing to do (no pref, no legacy global)", () => {
    const plan = planWipLimitMigration(map({ [`board_strategy_${P}`]: bullseye({ activeAgentsTarget: 6 }) }), [P]);
    expect(plan).toEqual({ writes: [], deletes: [], skipped: [] });
  });

  it("both: the per-project pref WINS and overwrites the Bullseye target, keeping the rest", () => {
    const prefMap = map({
      [`wip_limit_${P}`]: "2",
      [`board_strategy_${P}`]: bullseye({ activeAgentsTarget: 6, providerPolicies: [{ id: "x", model: "opus" }] }),
    });
    const plan = planWipLimitMigration(prefMap, [P]);
    expect(plan.writes.map((w) => w.reason)).toEqual(["pref_overrides_bullseye"]);
    const written = JSON.parse(plan.writes[0].value);
    expect(written.activeAgentsTarget).toBe(2);
    expect(written.providerPolicies[0].model).toBe("opus");
    expect(plan.deletes.map((d) => d.key)).toEqual([`wip_limit_${P}`]);
  });

  it("neither: nothing to do", () => {
    expect(planWipLimitMigration(map({}), [P])).toEqual({ writes: [], deletes: [], skipped: [] });
  });

  it("a Bullseye without a target takes the pref", () => {
    const plan = planWipLimitMigration(map({ [`wip_limit_${P}`]: "3", [`board_strategy_${P}`]: bullseye({ segments: [] }) }), [P]);
    expect(plan.writes.map((w) => [w.reason, JSON.parse(w.value).activeAgentsTarget])).toEqual([["pref_into_targetless_bullseye", 3]]);
  });

  it("pref equal to the Bullseye target: no write, just the delete", () => {
    const plan = planWipLimitMigration(map({ [`wip_limit_${P}`]: "4", [`board_strategy_${P}`]: bullseye({ activeAgentsTarget: 4 }) }), [P]);
    expect(plan.writes).toEqual([]);
    expect(plan.deletes.map((d) => d.reason)).toEqual(["pref_matches_bullseye"]);
  });

  it("the legacy global fills ONLY a Bullseye that exists without a target", () => {
    const prefMap = map({
      nudge_wip_limit: "3",
      [`board_strategy_${P}`]: bullseye({ segments: [] }),
      [`board_strategy_${Q}`]: bullseye({ activeAgentsTarget: 8 }),
    });
    const plan = planWipLimitMigration(prefMap, [P, Q, "33333333-3333-3333-3333-333333333333"]);
    expect(plan.writes.map((w) => [w.projectId, w.reason, JSON.parse(w.value).activeAgentsTarget])).toEqual([
      [P, "nudge_into_targetless_bullseye", 3],
    ]);
    expect(plan.deletes).toEqual([]);
  });

  it("never overwrites a malformed Bullseye — the pref row is kept and reported", () => {
    const plan = planWipLimitMigration(map({ [`wip_limit_${P}`]: "2", [`board_strategy_${P}`]: "{oops" }), [P]);
    expect(plan.writes).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(plan.skipped).toEqual([{ projectId: P, key: `wip_limit_${P}`, reason: "bullseye_malformed" }]);
  });

  it("drops a junk pref the resolver always ignored, without inventing a target", () => {
    const plan = planWipLimitMigration(map({ [`wip_limit_${P}`]: "soon" }), [P]);
    expect(plan.writes).toEqual([]);
    expect(plan.deletes.map((d) => d.reason)).toEqual(["invalid_pref_dropped"]);
  });

  it("leaves a per-COLUMN wip_limit_<statusId> row alone — only registered project ids are migrated", () => {
    const statusId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(planWipLimitMigration(map({ [`wip_limit_${statusId}`]: "3" }), [P])).toEqual({ writes: [], deletes: [], skipped: [] });
  });
});

async function seedProject(db: TestDb): Promise<string> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(projects).values({ id, name: `p-${id.slice(0, 4)}`, repoPath: `/tmp/wip-migration-${id}`, repoName: "r", defaultBranch: "main", createdAt: now, updatedAt: now });
  return id;
}

async function pref(db: TestDb, key: string): Promise<string | undefined> {
  return (await db.select({ value: preferences.value }).from(preferences).where(eq(preferences.key, key)))[0]?.value;
}

describe("migrateWipLimitPrefsIntoBullseye — against a real database", () => {
  it("persists through the checked write path, deletes the retired row, keeps the monitor's number, and is idempotent", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const columnStatusId = randomUUID();
    await db.insert(preferences).values([
      { key: `wip_limit_${projectId}`, value: "2" },
      { key: `board_strategy_${projectId}`, value: bullseye({ activeAgentsTarget: 6, segments: [] }) },
      { key: `wip_limit_${columnStatusId}`, value: "4" },
    ]);
    const lines: string[] = [];

    const first = await migrateWipLimitPrefsIntoBullseye({ database: db as never, log: (l) => lines.push(l) });
    expect(first.writes).toHaveLength(1);
    expect(await pref(db, `wip_limit_${projectId}`)).toBeUndefined();
    expect(JSON.parse((await pref(db, `board_strategy_${projectId}`))!).activeAgentsTarget).toBe(2);
    // The column-limit row is orphaned, not migrated.
    expect(await pref(db, `wip_limit_${columnStatusId}`)).toBe("4");

    // The resolver now answers 2 from the Bullseye — the same number the monitor ran at before.
    const prefMap = new Map((await db.select().from(preferences)).map((r) => [r.key, r.value]));
    expect(resolveWipLimit(prefMap, projectId)).toEqual({ limit: 2, configured: 2, source: "strategy" });
    expect(lines.some((l) => l.startsWith("[wip-limit-migration] pref_overrides_bullseye"))).toBe(true);

    const second = await migrateWipLimitPrefsIntoBullseye({ database: db as never, log: () => {} });
    expect(second).toEqual({ writes: [], deletes: [], skipped: [] });
  });

  it("is a no-op on a board with none of the retired keys", async () => {
    const { db } = createTestDb();
    await seedProject(db);
    const writes: unknown[] = [];
    const plan = await migrateWipLimitPrefsIntoBullseye({ database: db as never, write: async (_d, e) => { writes.push(e); } });
    expect(plan).toEqual({ writes: [], deletes: [], skipped: [] });
    expect(writes).toEqual([]);
  });
});
