/**
 * 2026-08-11 perf audit — `loopStatuses` cost rollup is opt-out.
 *
 * The session-cost rollup (#294) is an unbounded sessions→workspaces→issues join plus a
 * JSON.parse per stats blob, and the cross-project inbox poll ran it for every loop of
 * every project without ever rendering a cost. `loopStatuses` now takes
 * `{ includeCosts }` (default true — the plugin panel keeps its "$X so far"), and the
 * inbox path passes `false`, which must SKIP the stats query entirely, not just hide
 * the number.
 */
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { pluginLoopUnitKey, type PluginManifest } from "@agentic-kanban/shared/lib/plugin-manifest";
import { createTestDb } from "./helpers/test-db.js";
import { seedProject, seedIssue } from "./helpers/workflow-test-helpers.js";
import type { Database } from "../db/index.js";

const sessionStatsSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../repositories/plugins.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/plugins.repository.js")>();
  return {
    ...actual,
    listPluginLoopSessionStats: (...args: Parameters<typeof actual.listPluginLoopSessionStats>) => {
      sessionStatsSpy.calls += 1;
      return actual.listPluginLoopSessionStats(...args);
    },
  };
});

import { createPluginLoopEngine } from "../services/plugin-loop.service.js";

const MANIFEST = {
  id: "cost-plugin",
  name: "Cost Plugin",
  loops: [{ name: "extract", skill: "analysis", plan: { command: "exit 1", cwd: "plugin" } }],
} as unknown as PluginManifest;

async function seedLoopWithSessions() {
  const { db } = createTestDb();
  const { projectId, statusId } = await seedProject(db, `cost-skip-${randomUUID().slice(0, 8)}`);
  const issueId = await seedIssue(db, projectId, statusId, 1, "unit ticket", {
    externalKey: pluginLoopUnitKey("cost-plugin", "extract", "unit-1"),
  });
  const now = new Date().toISOString();
  const workspaceId = randomUUID();
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/cost-skip",
    createdAt: now,
    updatedAt: now,
  });
  for (const cost of [1.25, 0.75]) {
    await db.insert(schema.sessions).values({
      id: randomUUID(),
      workspaceId,
      executor: "claude-code",
      status: "stopped",
      startedAt: now,
      stats: JSON.stringify({ totalCostUsd: cost }),
    });
  }
  const engine = createPluginLoopEngine({ database: db as unknown as Database, boardUrl: "http://127.0.0.1:0" });
  return { engine, projectId };
}

describe("loopStatuses cost rollup opt-out (2026-08-11 perf audit)", () => {
  it("folds session costs into totalCostUsd by default", async () => {
    const { engine, projectId } = await seedLoopWithSessions();
    sessionStatsSpy.calls = 0;

    const statuses = await engine.loopStatuses(MANIFEST, "cost-plugin", projectId);

    expect(statuses).toHaveLength(1);
    expect(statuses[0].totalCostUsd).toBeCloseTo(2.0, 5);
    expect(sessionStatsSpy.calls).toBeGreaterThan(0);
  });

  it("includeCosts: false skips the sessions-join entirely and reports null", async () => {
    const { engine, projectId } = await seedLoopWithSessions();
    sessionStatsSpy.calls = 0;

    const statuses = await engine.loopStatuses(MANIFEST, "cost-plugin", projectId, { includeCosts: false });

    expect(statuses).toHaveLength(1);
    expect(statuses[0].totalCostUsd).toBeNull();
    expect(sessionStatsSpy.calls).toBe(0);
    // Everything else the inbox reads is untouched by the skip.
    expect(statuses[0].openTickets).toBe(1);
    expect(statuses[0].name).toBe("extract");
  });
});
