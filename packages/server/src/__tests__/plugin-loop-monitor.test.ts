import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import {
  pluginEnabledPreferenceKey,
  pluginLoopPausedPreferenceKey,
  pluginLoopUnitKey,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import { createTestDb, type TestDb, ensureTestStatus } from "./helpers/test-db.js";
import { seedProject, seedIssue } from "./helpers/workflow-test-helpers.js";
import { advanceDuePluginLoops } from "../services/plugin-loop-monitor.js";
import { createPluginService } from "../services/plugin.service.js";
import type { Database } from "../db/index.js";

/**
 * A paused loop is the one direct way a human can stop a converging loop early
 * (#200) — the monitor's auto-advance pass must skip it entirely, leaving its
 * already-closed round alone rather than planning another one.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const MANIFEST = {
  id: "loop-plugin",
  name: "Loop Plugin",
  version: "0.1.0",
  skills: [{ dir: "skills/analysis" }],
  loops: [
    {
      name: "sweep",
      skill: "analysis",
      // Never expected to run in this test — a paused loop must not reach it,
      // and asserting it does NOT exit 0 makes an accidental invocation loud
      // (it would show up as an "advance failed" log line instead of silently
      // creating a ticket).
      plan: { command: "exit 1", cwd: "plugin" },
    },
  ],
};

function makePluginDir(): string {
  const dir = makeTempDir("ak-loop-monitor-plugin-");
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify(MANIFEST, null, 2));
  return dir;
}

async function setupLoopWithOneClosedRound(db: TestDb) {
  const { projectId } = await seedProject(db, "Loop Project");
  // #668: `seedProject` already seeds the canonical set, which includes "Done" — inserting
  // another one built a second Done column. Reuse the one the project already has.
  const doneStatusId = await ensureTestStatus(db, projectId, "Done", { sortOrder: 1, isDefault: false });
  await seedIssue(db, projectId, doneStatusId, 1, "round 1 unit", {
    externalKey: pluginLoopUnitKey("loop-plugin", "sweep", "unit-1"),
  });

  const service = createPluginService({ database: db as unknown as Database });
  const pluginDir = makePluginDir();
  const plugin = await service.installPlugin({ source: pluginDir });
  await db.insert(schema.preferences).values({
    key: pluginEnabledPreferenceKey("loop-plugin", projectId),
    value: "true",
    updatedAt: new Date().toISOString(),
  });

  return { projectId, plugin, service };
}

describe("advanceDuePluginLoops — pause", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — best-effort cleanup */
      }
    }
  });

  it("skips a paused loop entirely, without running its plan command", async () => {
    const { db } = createTestDb();
    const { projectId } = await setupLoopWithOneClosedRound(db);
    await db.insert(schema.preferences).values({
      key: pluginLoopPausedPreferenceKey("loop-plugin", "sweep", projectId),
      value: "true",
      updatedAt: new Date().toISOString(),
    });

    const logs: string[] = [];
    const advanced = await advanceDuePluginLoops(db as unknown as Database, {
      allowProject: () => true,
      log: (message) => logs.push(message),
    });

    expect(advanced).toBe(0);
    expect(logs).toEqual([]);
  });

  it("advances (attempts) an unpaused loop whose round is closed", async () => {
    const { db } = createTestDb();
    const { projectId } = await setupLoopWithOneClosedRound(db);
    // No pause pref written — the loop is unpaused by default.

    const logs: string[] = [];
    const advanced = await advanceDuePluginLoops(db as unknown as Database, {
      allowProject: () => true,
      log: (message) => logs.push(message),
    });

    // The plan command deliberately fails (exit 1), so this proves the loop WAS
    // reached (unlike the paused case, which logs nothing at all).
    expect(advanced).toBe(0);
    expect(logs.some((m) => m.includes("loop-plugin:sweep advance failed"))).toBe(true);
    void projectId;
  });
});

/**
 * #372 — a loop whose last advance produced nothing ("blocked, not done": an unresolved gate or an
 * unfinished upstream) must not be re-planned faster than the configured monitor interval. This
 * pass runs once per monitor CYCLE, and cycles are also event-triggered, so without an explicit
 * gate a blocked loop was advanced at the cycle cadence — MEASURED median 91s under a 240s
 * interval, i.e. one wasted planner subprocess every ~90s per blocked loop.
 */
describe("advanceDuePluginLoops — blocked-loop interval gating (#372)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — best-effort cleanup */
      }
    }
  });

  async function seedNoOpAdvance(db: TestDb, projectId: string, ageMs: number) {
    await db.insert(schema.pluginLoopEvents).values({
      id: randomUUID(),
      pluginSlug: "loop-plugin",
      loopName: "sweep",
      projectId,
      type: "advance",
      // The shape a blocked advance really persists: nothing planned, nothing created,
      // NOT converged, waiting on a gate.
      payloadJson: JSON.stringify({ planned: 0, created: [], converged: false, gate: { id: "step-3:v1" } }),
      createdAt: new Date(Date.now() - ageMs).toISOString(),
    });
  }

  it("skips a blocked loop whose last no-op advance is younger than the interval", async () => {
    const { db } = createTestDb();
    const { projectId } = await setupLoopWithOneClosedRound(db);
    await seedNoOpAdvance(db, projectId, 90_000); // the measured real cadence

    const logs: string[] = [];
    const advanced = await advanceDuePluginLoops(db as unknown as Database, {
      allowProject: () => true,
      log: (message) => logs.push(message),
      minBlockedAdvanceIntervalMs: 240_000,
    });

    expect(advanced).toBe(0);
    // The plan command is `exit 1`, so reaching the planner is always visible as a log line.
    expect(logs).toEqual([]);
  });

  it("advances a blocked loop again once the interval has elapsed", async () => {
    const { db } = createTestDb();
    const { projectId } = await setupLoopWithOneClosedRound(db);
    await seedNoOpAdvance(db, projectId, 300_000);

    const logs: string[] = [];
    await advanceDuePluginLoops(db as unknown as Database, {
      allowProject: () => true,
      log: (message) => logs.push(message),
      minBlockedAdvanceIntervalMs: 240_000,
    });

    expect(logs.some((m) => m.includes("loop-plugin:sweep advance failed"))).toBe(true);
  });

  it("does not gate a loop whose last advance actually created tickets", async () => {
    const { db } = createTestDb();
    const { projectId } = await setupLoopWithOneClosedRound(db);
    await db.insert(schema.pluginLoopEvents).values({
      id: randomUUID(),
      pluginSlug: "loop-plugin",
      loopName: "sweep",
      projectId,
      type: "advance",
      payloadJson: JSON.stringify({ planned: 1, created: [{ unitId: "unit-1" }], converged: false }),
      createdAt: new Date(Date.now() - 5_000).toISOString(),
    });

    const logs: string[] = [];
    await advanceDuePluginLoops(db as unknown as Database, {
      allowProject: () => true,
      log: (message) => logs.push(message),
      minBlockedAdvanceIntervalMs: 240_000,
    });

    expect(logs.some((m) => m.includes("loop-plugin:sweep advance failed"))).toBe(true);
  });
});
