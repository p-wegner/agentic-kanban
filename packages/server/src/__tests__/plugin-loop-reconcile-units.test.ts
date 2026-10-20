import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { pluginLoopUnitKey } from "@agentic-kanban/shared/lib/plugin-manifest";
import { createTestDb, ensureTestStatus, type TestDb } from "./helpers/test-db.js";
import { seedProject, seedIssue } from "./helpers/workflow-test-helpers.js";
import { createPluginService } from "../services/plugin.service.js";
import type { Database } from "../db/index.js";
import type { CreateIssueInput, CreateIssueResult } from "../services/issue.service.js";
import { nextRoundUnitId } from "../services/plugin/loop-unit-reconcile.js";

/**
 * `reconcileUnits` loops (#1643): the board's tickets follow the plan. Found on the live jira-sync
 * sync-conflicts loop, where a conflict ticket closed without the sync accepting it left the loop
 * "outstanding" with nothing driving it, and a failed-push ticket stayed in Todo after its cause
 * went away. A plain loop's "an existing ticket, terminal or not, is final" contract is untouched
 * (`plugin-loop-invariants.test.ts`); these rules apply only to a loop that opts in.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Own parent dir per repo: `setOutputLocation(…, "sidecar")` derives a FIXED sibling name. */
function makeProjectRepo(): string {
  const parent = makeTempDir("ak-loop-rec-parent-");
  const repo = join(parent, "product-repo");
  mkdirSync(repo, { recursive: true });
  gitExecSync(["init"], { cwd: repo });
  return repo;
}

const SLUG = "rec-plugin";

function manifest(planEnv: Record<string, string> = {
  PLAN_LOG: "{{pluginPath}}/plan-log.txt",
  PLAN_DIR: "{{pluginPath}}",
}) {
  return {
    id: SLUG,
    name: "Reconcile Plugin",
    version: "0.1.0",
    skills: [{ dir: "skills/analysis" }],
    loops: [
      { name: "sweep", skill: "analysis", reconcileUnits: true, plan: { command: "node plan.mjs", cwd: "plugin", env: planEnv } },
    ],
  };
}

/**
 * A plugin whose planner emits the JSON in `plan-<n>.json` for the n-th run, so a test can
 * script a SEQUENCE of plans (round 1, then round 2) — and records every run, so "was the
 * planner consulted at all?" is observable.
 */
function makeScriptedPluginDir(plans: unknown[]): string {
  const dir = makeTempDir("ak-loop-rec-plugin-");
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify(manifest(), null, 2));
  const skillDir = join(dir, "skills", "analysis");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# analysis");
  for (const [i, plan] of plans.entries()) {
    writeFileSync(join(dir, `plan-${i}.json`), JSON.stringify(plan));
  }
  // The plugin dir arrives as `PLAN_DIR` (a substituted `{{pluginPath}}`) rather than being
  // derived from the script's own location: a test file that anchors a disk read at its own
  // module path, next to a `../` import, matches the always-run-marker ratchet's
  // "reads-outside-own-dir" signature — and this suite reads nothing but its own fixtures.
  writeFileSync(
    join(dir, "plan.mjs"),
    "import { appendFileSync, readFileSync } from 'node:fs';\n"
      + "import { join } from 'node:path';\n"
      + "const log = process.env.PLAN_LOG;\n"
      + "appendFileSync(log, 'ran\\n');\n"
      + "const n = readFileSync(log, 'utf8').trim().split(/\\r?\\n/).filter(Boolean).length - 1;\n"
      + `const last = ${plans.length - 1};\n`
      + "const file = join(process.env.PLAN_DIR, `plan-${Math.min(n, last)}.json`);\n"
      + "console.log(readFileSync(file, 'utf8'));\n",
  );
  return dir;
}

function planRuns(pluginDir: string): number {
  const log = join(pluginDir, "plan-log.txt");
  if (!existsSync(log)) return 0;
  return readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean).length;
}

/** A `createIssue` that really inserts, so the next advance's dedupe read can see it. */
function makeCreateIssue(db: TestDb, projectId: string, statusId: string, startAt = 100) {
  let issueNumber = startAt;
  return async (input: CreateIssueInput): Promise<CreateIssueResult> => {
    const now = new Date().toISOString();
    const id = randomUUID();
    issueNumber += 1;
    await db.insert(schema.issues).values({
      id,
      title: input.title,
      description: input.description ?? null,
      priority: "medium",
      sortOrder: 0,
      statusId,
      projectId,
      issueNumber,
      externalKey: input.externalKey ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return { id, issueNumber } as CreateIssueResult;
  };
}

async function setup(db: TestDb, pluginDir: string) {
  const { projectId, statusIds } = await seedProject(db, `rec-${randomUUID().slice(0, 8)}`);
  const backlogId = statusIds["Backlog"] ?? Object.values(statusIds)[0];
  const service = createPluginService({
    database: db as unknown as Database,
    createIssue: makeCreateIssue(db, projectId, backlogId),
  });
  const plugin = await service.installPlugin({ source: pluginDir });
  return { projectId, statusIds, service, plugin };
}


const KEY = (unit: string) => pluginLoopUnitKey(SLUG, "sweep", unit);

async function issuesByKey(db: TestDb, projectId: string) {
  const rows = await db.select().from(schema.issues).where(eq(schema.issues.projectId, projectId));
  return new Map(rows.map((r) => [r.externalKey, r]));
}

describe("plugin loop reconcileUnits (#1643)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks: best-effort cleanup */
      }
    }
  });

  it("nextRoundUnitId bumps the :r<N> suffix", () => {
    expect(nextRoundUnitId("conflict:KD-49:r1")).toBe("conflict:KD-49:r2");
    expect(nextRoundUnitId("conflict:KD-49:r9")).toBe("conflict:KD-49:r10");
    expect(nextRoundUnitId("plain")).toBe("plain:r2");
  });

  it("a Done ticket whose unit is STILL planned opens the next round instead of a silent skip", async () => {
    const { db } = createTestDb();
    const pluginDir = makeScriptedPluginDir([
      { units: [{ id: "conflict:KD-49:r1", title: "Resolve KD-49", description: "still diverged" }], converged: false },
    ]);
    const { projectId, service, plugin } = await setup(db, pluginDir);
    const doneId = await ensureTestStatus(db, projectId, "Done", { sortOrder: 9, isDefault: false });
    await seedIssue(db, projectId, doneId, 1, "Round 1", { externalKey: KEY("conflict:KD-49:r1") });

    const second = await service.advanceLoop(plugin.id, "sweep", projectId);
    expect(second.created.map((c) => c.unitId)).toEqual(["conflict:KD-49:r2"]);
    expect(second.skippedExisting).toEqual([]);
    const issues = await issuesByKey(db, projectId);
    const round2 = issues.get(KEY("conflict:KD-49:r2"));
    expect(round2?.description).toContain("#1");
    expect(round2?.description).toContain("still diverged");
    expect(round2?.description).toMatch(/did not resolve it/);

    // r2 is open now: the next advance skips it, and does not mint r3.
    const third = await service.advanceLoop(plugin.id, "sweep", projectId);
    expect(third.created).toEqual([]);
    expect(third.skippedExisting.map((s) => s.unitId)).toEqual(["conflict:KD-49:r2"]);
  });

  it("a Done round-2 ticket that still does not settle the unit opens round 3", async () => {
    const { db } = createTestDb();
    const pluginDir = makeScriptedPluginDir([{ units: [{ id: "u:r1", title: "U" }], converged: false }]);
    const { projectId, service, plugin } = await setup(db, pluginDir);
    const doneId = await ensureTestStatus(db, projectId, "Done", { sortOrder: 9, isDefault: false });
    await seedIssue(db, projectId, doneId, 1, "r1", { externalKey: KEY("u:r1") });
    await seedIssue(db, projectId, doneId, 2, "r2", { externalKey: KEY("u:r2") });

    const result = await service.advanceLoop(plugin.id, "sweep", projectId);
    expect(result.created.map((c) => c.unitId)).toEqual(["u:r3"]);
  });

  it("closes the open ticket of a unit the plan no longer reports, with a comment", async () => {
    const { db } = createTestDb();
    const pluginDir = makeScriptedPluginDir([{ units: [], converged: true, note: "converged" }]);
    const { projectId, service, plugin } = await setup(db, pluginDir);
    const todoId = await ensureTestStatus(db, projectId, "Todo", { sortOrder: 1, isDefault: false });
    await ensureTestStatus(db, projectId, "Done", { sortOrder: 9, isDefault: false });
    await seedIssue(db, projectId, todoId, 7, "Fix failed push: KD-51", {
      externalKey: KEY("push-failed:KD-51:r1"),
    });

    const result = await service.advanceLoop(plugin.id, "sweep", projectId);
    expect(result.closedResolved).toEqual([
      expect.objectContaining({ unitId: "push-failed:KD-51:r1", issueNumber: 7 }),
    ]);

    const issues = await issuesByKey(db, projectId);
    const closed = issues.get(KEY("push-failed:KD-51:r1"));
    const statuses = await db.select().from(schema.projectStatuses).where(eq(schema.projectStatuses.projectId, projectId));
    expect(statuses.find((s) => s.id === closed?.statusId)?.name).toBe("Done");
    const comments = await db.select().from(schema.issueComments).where(eq(schema.issueComments.issueId, closed!.id));
    expect(comments.map((c) => c.body).join("\n")).toMatch(/Resolved by sync at /);
  });

  it("does not close anything while the plan is the blocked 'units: [], converged: false' state", async () => {
    const { db } = createTestDb();
    const pluginDir = makeScriptedPluginDir([{ units: [], converged: false, note: "no pull has run yet" }]);
    const { projectId, service, plugin } = await setup(db, pluginDir);
    const todoId = await ensureTestStatus(db, projectId, "Todo", { sortOrder: 1, isDefault: false });
    await ensureTestStatus(db, projectId, "Done", { sortOrder: 9, isDefault: false });
    await seedIssue(db, projectId, todoId, 7, "Open", { externalKey: KEY("conflict:KD-49:r1") });

    const result = await service.advanceLoop(plugin.id, "sweep", projectId);
    expect(result.closedResolved).toBeUndefined();
    const issues = await issuesByKey(db, projectId);
    expect(issues.get(KEY("conflict:KD-49:r1"))?.statusId).toBe(todoId);
  });

  it("keeps the open ticket of a unit that is still planned, including a re-opened round's key", async () => {
    const { db } = createTestDb();
    const pluginDir = makeScriptedPluginDir([{ units: [{ id: "u:r1", title: "U" }], converged: false }]);
    const { projectId, service, plugin } = await setup(db, pluginDir);
    const doneId = await ensureTestStatus(db, projectId, "Done", { sortOrder: 9, isDefault: false });
    const todoId = await ensureTestStatus(db, projectId, "Todo", { sortOrder: 1, isDefault: false });
    await seedIssue(db, projectId, doneId, 1, "r1", { externalKey: KEY("u:r1") });
    await seedIssue(db, projectId, todoId, 2, "r2", { externalKey: KEY("u:r2") });

    const result = await service.advanceLoop(plugin.id, "sweep", projectId);
    expect(result.closedResolved).toBeUndefined();
    expect(result.skippedExisting.map((s) => s.unitId)).toEqual(["u:r2"]);
    const issues = await issuesByKey(db, projectId);
    expect(issues.get(KEY("u:r2"))?.statusId).toBe(todoId);
  });
});
