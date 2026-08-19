import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import {
  pluginEnabledPreferenceKey,
  pluginLoopConvergedPreferenceKey,
  pluginLoopUnitKey,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import { createTestDb, type TestDb, ensureTestStatus } from "./helpers/test-db.js";
import { seedProject, seedIssue } from "./helpers/workflow-test-helpers.js";
import { advanceDuePluginLoops, DEFAULT_MIN_BLOCKED_ADVANCE_INTERVAL_MS } from "../services/plugin-loop-monitor.js";
import { getPluginService } from "../services/plugin.service.js";
import type { Database } from "../db/index.js";
import type { CreateIssueInput, CreateIssueResult } from "../services/issue.service.js";

/**
 * Convergence is PERSISTED, not just reported.
 *
 * A loop whose tickets were all closed and whose planner said "nothing left to do" used to be
 * replanned on every monitor cycle indefinitely — one planner subprocess per finished loop per
 * ~4-minute cycle — and only an explicit pause stopped it. The distinction that must survive:
 * `units: [], converged: true` is terminal, `units: [], converged: false` is "blocked, not done"
 * and keeps polling.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function manifest(): Record<string, unknown> {
  return {
    id: "converge-plugin",
    name: "Converge Plugin",
    skills: [{ dir: "skills/analysis" }],
    loops: [
      {
        name: "sweep",
        skill: "analysis",
        plan: { command: "node plan.mjs", cwd: "plugin", env: { PLAN_LOG: "{{pluginPath}}/plans.txt" } },
      },
    ],
  };
}

/** A planner that records every invocation, so "was it run again?" is observable. */
function makePluginDir(converged: boolean): string {
  const dir = makeTempDir("loop-converge-plugin-");
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify(manifest(), null, 2));
  const skillDir = join(dir, "skills", "analysis");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# analysis");
  writeFileSync(
    join(dir, "plan.mjs"),
    "import { appendFileSync } from 'node:fs';\n"
      + "appendFileSync(process.env.PLAN_LOG, 'ran\\n');\n"
      + `console.log(JSON.stringify({ units: [], converged: ${converged}, note: 'n' }));\n`,
  );
  return dir;
}

function planRuns(pluginDir: string): number {
  const log = join(pluginDir, "plans.txt");
  if (!existsSync(log)) return 0;
  return readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean).length;
}

async function setupClosedRound(db: TestDb, pluginDir: string) {
  const { projectId } = await seedProject(db, "Converge Project");
  // #668: `seedProject` already seeds the canonical set, which includes "Done" — inserting
  // another one built a second Done column. Reuse the one the project already has.
  const doneStatusId = await ensureTestStatus(db, projectId, "Done", { sortOrder: 1, isDefault: false });
  await seedIssue(db, projectId, doneStatusId, 1, "round 1 unit", {
    externalKey: pluginLoopUnitKey("converge-plugin", "sweep", "unit-1"),
  });

  const createIssue = async (input: CreateIssueInput): Promise<CreateIssueResult> => {
    void input;
    throw new Error("this test's planner never plans units");
  };
  // Via the memoized accessor, because `advanceDuePluginLoops` resolves the service the same way —
  // a locally constructed instance would leave the monitor's copy without `createIssue`, and its
  // advance would fail with "not available on this route" before ever running a planner.
  const service = getPluginService(db as unknown as Database, { createIssue });
  const plugin = await service.installPlugin({ source: pluginDir });
  await db.insert(schema.preferences).values({
    key: pluginEnabledPreferenceKey("converge-plugin", projectId),
    value: "true",
    updatedAt: new Date().toISOString(),
  });
  return { projectId, plugin, service };
}

describe("plugin loop convergence is persisted", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — best-effort cleanup */
      }
    }
  });

  it("a converged plan stops the monitor from running the planner again", async () => {
    const { db } = createTestDb();
    const pluginDir = makePluginDir(true);
    const { projectId, plugin, service } = await setupClosedRound(db, pluginDir);

    const logs: string[] = [];
    const run = () => advanceDuePluginLoops(db as unknown as Database, { allowProject: () => true, log: (m) => logs.push(m) });

    await run();
    expect(planRuns(pluginDir)).toBe(1);
    expect(logs.some((m) => m.includes("converge-plugin:sweep converged"))).toBe(true);

    // Second cycle: the verdict is on record, so the planner is not spawned at all.
    await run();
    expect(planRuns(pluginDir)).toBe(1);

    const statuses = await service.listLoops(plugin.id, projectId);
    expect(statuses[0]).toMatchObject({ name: "sweep", converged: true });

    // …and a manual advance still replans it — the restart path.
    await service.advanceLoop(plugin.id, "sweep", projectId);
    expect(planRuns(pluginDir)).toBe(2);
  });

  it("'units: [], converged: false' (blocked, not done) keeps being polled", async () => {
    const { db } = createTestDb();
    const pluginDir = makePluginDir(false);
    const { projectId } = await setupClosedRound(db, pluginDir);

    const run = (now?: number) => advanceDuePluginLoops(db as unknown as Database, { allowProject: () => true, log: () => {}, now });
    await run();
    // #372: still POLLED (unlike a converged loop, which is skipped forever) — but not faster than
    // the monitor interval. A back-to-back cycle, which is what an event-triggered board mutation
    // produces, must not spawn a second planner.
    await run();
    expect(planRuns(pluginDir)).toBe(1);
    // …and once the interval has elapsed it is polled again.
    await run(Date.now() + DEFAULT_MIN_BLOCKED_ADVANCE_INTERVAL_MS + 1_000);
    expect(planRuns(pluginDir)).toBe(2);

    const pref = await db
      .select()
      .from(schema.preferences)
      .where(eqKey(pluginLoopConvergedPreferenceKey("converge-plugin", "sweep", projectId)));
    expect(pref[0]?.value).toBe("false");
  });
});

/** Local helper so the test reads as a query, not a drizzle expression. */
function eqKey(key: string) {
  return eq(schema.preferences.key, key);
}
