import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import {
  pluginLoopConvergedPreferenceKey,
  pluginLoopUnitKey,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import { createTestDb, ensureTestStatus, type TestDb } from "./helpers/test-db.js";
import { seedProject, seedIssue } from "./helpers/workflow-test-helpers.js";
import { createPluginService } from "../services/plugin.service.js";
import { advanceDuePluginLoops } from "../services/plugin-loop-monitor.js";
import type { Database } from "../db/index.js";
import type { CreateIssueInput, CreateIssueResult } from "../services/issue.service.js";

/**
 * The plugin-loop invariants that FAIL SILENTLY — the ones CLAUDE.md calls out because
 * breaking any of them produces no error, just a loop that quietly does the wrong thing
 * forever. Each was verified untested before this file (#727):
 *
 * 1. **Unit ids are the planner's contract.** An advance skips any unit whose
 *    `pluginLoopUnitKey` already carries a ticket — TERMINAL OR NOT. The existing suite
 *    only ever exercised the open-ticket case (`plugin-loop-concurrency.test.ts`), so the
 *    load-bearing half — a *closed* round is not re-ticketed, and a fresh id is the only
 *    way to get another pass — had no guard. Losing it turns every converging loop into an
 *    infinite ticket generator.
 * 2. **`converged` is a claim about the JOB, not the ready set.** Only `units: []` AND an
 *    affirmative `converged` is terminal; `converged: true` alongside planned units is a
 *    planner still handing out work, and any advance that plans units CLEARS the flag (the
 *    restart path). `plugin-loop-convergence.test.ts` covered the two empty-plan cases and
 *    neither of these.
 * 3. **`{{repoPath}}` is the OUTPUT repo, `{{leadingRepoPath}}` is always the product
 *    repo** (#213) — asserted for butler fragments and `runScript`, never for the LOOP
 *    planner, which is the one substitution site a sidecar plugin lives or dies by.
 * 4. **The monitor never STARTS a loop** — it only continues one that already has tickets.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Own parent dir per repo: `setOutputLocation(…, "sidecar")` derives a FIXED sibling name. */
function makeProjectRepo(): string {
  const parent = makeTempDir("loop-inv-parent-");
  const repo = join(parent, "product-repo");
  mkdirSync(repo, { recursive: true });
  gitExecSync(["init"], { cwd: repo });
  return repo;
}

const SLUG = "inv-plugin";

function manifest(planEnv: Record<string, string> = { PLAN_LOG: "{{pluginPath}}/plan-log.txt" }) {
  return {
    id: SLUG,
    name: "Invariant Plugin",
    version: "0.1.0",
    skills: [{ dir: "skills/analysis" }],
    loops: [
      { name: "sweep", skill: "analysis", plan: { command: "node plan.mjs", cwd: "plugin", env: planEnv } },
    ],
  };
}

/**
 * A plugin whose planner emits the JSON in `plan-<n>.json` for the n-th run, so a test can
 * script a SEQUENCE of plans (round 1, then round 2) — and records every run, so "was the
 * planner consulted at all?" is observable.
 */
function makeScriptedPluginDir(plans: unknown[]): string {
  const dir = makeTempDir("loop-inv-plugin-");
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify(manifest(), null, 2));
  const skillDir = join(dir, "skills", "analysis");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# analysis");
  for (const [i, plan] of plans.entries()) {
    writeFileSync(join(dir, `plan-${i}.json`), JSON.stringify(plan));
  }
  writeFileSync(
    join(dir, "plan.mjs"),
    "import { appendFileSync, readFileSync, existsSync } from 'node:fs';\n"
      + "import { join, dirname } from 'node:path';\n"
      + "const here = dirname(new URL(import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/, '$1'));\n"
      + "const log = process.env.PLAN_LOG;\n"
      + "appendFileSync(log, 'ran\\n');\n"
      + "const n = readFileSync(log, 'utf8').trim().split(/\\r?\\n/).filter(Boolean).length - 1;\n"
      + `const last = ${plans.length - 1};\n`
      + "const file = join(here, `plan-${Math.min(n, last)}.json`);\n"
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
  const { projectId, statusIds } = await seedProject(db, `inv-${randomUUID().slice(0, 8)}`);
  const backlogId = statusIds["Backlog"] ?? Object.values(statusIds)[0];
  const service = createPluginService({
    database: db as unknown as Database,
    createIssue: makeCreateIssue(db, projectId, backlogId),
  });
  const plugin = await service.installPlugin({ source: pluginDir });
  return { projectId, statusIds, service, plugin };
}

function convergedPref(db: TestDb, projectId: string): Promise<{ value: string }[]> {
  return db
    .select({ value: schema.preferences.value })
    .from(schema.preferences)
    .where(eq(schema.preferences.key, pluginLoopConvergedPreferenceKey(SLUG, "sweep", projectId)));
}

describe("plugin loop — unit ids are the planner's contract (#727)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — best-effort cleanup */
      }
    }
  });

  it("skips a unit whose ticket is already TERMINAL, instead of re-ticketing the closed round", async () => {
    const { db } = createTestDb();
    const pluginDir = makeScriptedPluginDir([
      { units: [{ id: "alpha", title: "Alpha" }, { id: "beta", title: "Beta" }], converged: false },
    ]);
    const { projectId, service, plugin } = await setup(db, pluginDir);

    // Round 1's ticket for `alpha` is DONE — the round is finished, not in flight.
    const doneId = await ensureTestStatus(db, projectId, "Done", { sortOrder: 9, isDefault: false });
    await seedIssue(db, projectId, doneId, 1, "Alpha (round 1)", {
      externalKey: pluginLoopUnitKey(SLUG, "sweep", "alpha"),
    });

    const result = await service.advanceLoop(plugin.id, "sweep", projectId);

    // `alpha` is accounted for by its CLOSED ticket and must not be planned again; only the
    // genuinely new unit becomes work.
    expect(result.created.map((c) => c.unitId)).toEqual(["beta"]);
    expect(result.skippedExisting).toEqual([
      expect.objectContaining({ unitId: "alpha", issueNumber: 1, statusName: "Done" }),
    ]);

    const keys = (await db.select().from(schema.issues).where(eq(schema.issues.projectId, projectId)))
      .map((r) => r.externalKey)
      .filter((k): k is string => k !== null)
      .sort();
    expect(keys).toEqual([
      pluginLoopUnitKey(SLUG, "sweep", "alpha"),
      pluginLoopUnitKey(SLUG, "sweep", "beta"),
    ]);
  });

  it("re-reporting the same id forever does nothing; a FRESH id is the only way to get another pass", async () => {
    const { db } = createTestDb();
    const pluginDir = makeScriptedPluginDir([
      { units: [{ id: "billing", title: "Billing" }], converged: false },
      { units: [{ id: "billing", title: "Billing" }], converged: false },
      { units: [{ id: "billing:r3", title: "Billing, round 3" }], converged: false },
    ]);
    const { projectId, service, plugin } = await setup(db, pluginDir);

    const first = await service.advanceLoop(plugin.id, "sweep", projectId);
    expect(first.created.map((c) => c.unitId)).toEqual(["billing"]);

    // The identical plan again: recognised as already ticketed, nothing created. This is what
    // makes an infinite ticket loop impossible without the board second-guessing the plan.
    const second = await service.advanceLoop(plugin.id, "sweep", projectId);
    expect(second.created).toEqual([]);
    expect(second.skippedExisting.map((s) => s.unitId)).toEqual(["billing"]);

    // A fresh id for the same subject is a NEW unit and is ticketed.
    const third = await service.advanceLoop(plugin.id, "sweep", projectId);
    expect(third.created.map((c) => c.unitId)).toEqual(["billing:r3"]);
    expect(planRuns(pluginDir)).toBe(3);
  });
});

describe("plugin loop — `converged` is a claim about the JOB, not the ready set (#727)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch { /* best effort */ }
    }
  });

  it("`converged: true` WITH planned units is a planner still handing out work, not a finished loop", async () => {
    const { db } = createTestDb();
    const pluginDir = makeScriptedPluginDir([
      { units: [{ id: "alpha", title: "Alpha" }], converged: true, note: "nearly there" },
    ]);
    const { projectId, service, plugin } = await setup(db, pluginDir);

    const result = await service.advanceLoop(plugin.id, "sweep", projectId);
    expect(result.created.map((c) => c.unitId)).toEqual(["alpha"]);
    // The planner's claim is REPORTED verbatim…
    expect(result.converged).toBe(true);
    // …but not PERSISTED as terminal: a loop that just handed out a ticket is not done, and
    // recording it as done would make the monitor skip the loop forever.
    expect((await convergedPref(db, projectId))[0]?.value).toBe("false");
    expect((await service.listLoops(plugin.id, projectId))[0]).toMatchObject({ converged: false });
  });

  it("an advance that plans units CLEARS a previously recorded convergence — the restart path", async () => {
    const { db } = createTestDb();
    const pluginDir = makeScriptedPluginDir([
      { units: [], converged: true, note: "done" },
      { units: [{ id: "reopened", title: "Reopened" }], converged: false },
    ]);
    const { projectId, service, plugin } = await setup(db, pluginDir);

    await service.advanceLoop(plugin.id, "sweep", projectId);
    expect((await convergedPref(db, projectId))[0]?.value).toBe("true");

    // A manual "Advance now" whose planner has found more work must un-retire the loop, or the
    // monitor would never look at it again.
    const second = await service.advanceLoop(plugin.id, "sweep", projectId);
    expect(second.created.map((c) => c.unitId)).toEqual(["reopened"]);
    expect((await convergedPref(db, projectId))[0]?.value).toBe("false");
  });
});

describe("plugin loop — the planner's {{repoPath}}/{{leadingRepoPath}} contract (#727)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch { /* best effort */ }
    }
  });

  it("hands the planner the OUTPUT repo as {{repoPath}} and the PRODUCT repo as {{leadingRepoPath}} in sidecar mode", async () => {
    const { db } = createTestDb();
    const pluginDir = makeTempDir("loop-inv-sidecar-plugin-");
    writeFileSync(
      join(pluginDir, "kanban-plugin.json"),
      JSON.stringify(manifest({ LEADING: "{{leadingRepoPath}}", OUTPUT: "{{repoPath}}" }), null, 2),
    );
    mkdirSync(join(pluginDir, "skills", "analysis"), { recursive: true });
    writeFileSync(join(pluginDir, "skills", "analysis", "SKILL.md"), "# analysis");
    // The plan's `note` is surfaced verbatim by `advanceLoop`, so the planner can report its own
    // substituted env without any ticket being created.
    writeFileSync(
      join(pluginDir, "plan.mjs"),
      "console.log(JSON.stringify({ units: [], converged: false, "
        + "note: process.env.LEADING + '|' + process.env.OUTPUT }));\n",
    );

    const repo = makeProjectRepo();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    await db.insert(schema.projects).values({
      id: projectId, name: "Sidecar Project", repoPath: repo, repoName: "product-repo",
      defaultBranch: "main", createdAt: now, updatedAt: now,
    });
    await db.insert(schema.projectStatuses).values({
      id: randomUUID(), projectId, name: "Backlog", sortOrder: 0, isDefault: true, createdAt: now,
    });

    const service = createPluginService({
      database: db as unknown as Database,
      createIssue: async () => { throw new Error("this planner never plans units"); },
    });
    const plugin = await service.installPlugin({ source: pluginDir });
    const { repoPath: sidecar } = await service.setOutputLocation(plugin.id, projectId, "sidecar");

    const result = await service.advanceLoop(plugin.id, "sweep", projectId);
    const [leading, output] = (result.note ?? "").split("|");
    // The product repo stays reachable — a plugin that READS the source and WRITES elsewhere
    // needs both, and conflating them is what #213 fixed everywhere except here.
    expect(leading).toBe(repo);
    expect(output).toBe(sidecar);
    expect(output).not.toBe(repo);
  });
});

describe("plugin loop — the monitor CONTINUES loops, it never starts one (#727)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch { /* best effort */ }
    }
  });

  it("does not consult the planner for an enabled loop that has no tickets at all", async () => {
    const { db } = createTestDb();
    const pluginDir = makeScriptedPluginDir([{ units: [{ id: "alpha", title: "Alpha" }], converged: false }]);
    const { projectId, service, plugin } = await setup(db, pluginDir);
    await service.enableForProject(plugin.id, projectId);

    // Opt-in by construction: a human presses "Advance" once, and only then does the monitor
    // take the loop over. Without a ticket to continue from, the planner is not even spawned.
    const advanced = await advanceDuePluginLoops(db as unknown as Database, {
      allowProject: () => true,
      log: () => {},
    });
    expect(advanced).toBe(0);
    expect(planRuns(pluginDir)).toBe(0);
  });
});
