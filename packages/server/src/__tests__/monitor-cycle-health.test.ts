import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import {
  classifyCycleFailures,
  deriveCycleHealthState,
  buildCycleLabel,
  listMonitorCycles,
  type MonitorCycleSummary,
} from "../services/monitor-cycle-health.service.js";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createRoutes } from "../routes/index.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

async function createProject(database: TestDb, name = "Cycle Project") {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await database.insert(schema.projects).values({
    id: projectId,
    name,
    repoPath: `C:/tmp/${projectId}`,
    repoName: name.toLowerCase().replace(/\s+/g, "-"),
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return projectId;
}

// ─── Unit: classifyCycleFailures ─────────────────────────────────────────────

describe("classifyCycleFailures", () => {
  it("returns no failures for normal cycles", () => {
    const result = classifyCycleFailures(
      ["Workspace merged", "Agent relaunched"],
      ["merge", "launch"],
      ["action", "action"],
    );
    expect(result).toEqual({ apiRestarted: false, smokeCheckFailed: false });
  });

  it("detects API restart from server category + restart keyword", () => {
    const result = classifyCycleFailures(
      ["Server restarted after crash"],
      ["server"],
      ["error"],
    );
    expect(result.apiRestarted).toBe(true);
    expect(result.smokeCheckFailed).toBe(false);
  });

  it("detects API restart from 'api restart' keyword", () => {
    const result = classifyCycleFailures(
      ["Detected api restart"],
      ["server"],
      ["observation"],
    );
    expect(result.apiRestarted).toBe(true);
  });

  it("detects smoke check failure when timed out + board content present", () => {
    const result = classifyCycleFailures(
      ["Frontend smoke check timed out despite board content rendered"],
      ["smoke_check"],
      ["error"],
    );
    expect(result.smokeCheckFailed).toBe(true);
    expect(result.apiRestarted).toBe(false);
  });

  it("detects smoke check failure on smoke_check error event even without content keyword", () => {
    const result = classifyCycleFailures(
      ["Frontend unavailable"],
      ["smoke_check"],
      ["error"],
    );
    expect(result.smokeCheckFailed).toBe(true);
  });

  it("does NOT flag smoke check failed for successful smoke check", () => {
    const result = classifyCycleFailures(
      ["Smoke check passed: board loaded successfully"],
      ["smoke_check"],
      ["observation"],
    );
    expect(result.smokeCheckFailed).toBe(false);
  });

  it("does NOT flag api restart for unrelated error events", () => {
    const result = classifyCycleFailures(
      ["Agent launch failed"],
      ["launch"],
      ["error"],
    );
    expect(result.apiRestarted).toBe(false);
  });
});

// ─── Unit: deriveCycleHealthState ────────────────────────────────────────────

describe("deriveCycleHealthState", () => {
  it("returns healthy for normal cycle with no errors", () => {
    expect(deriveCycleHealthState(["cycle_start", "action", "cycle_end"], false, false, 0)).toBe("healthy");
  });

  it("returns error when api restarted", () => {
    expect(deriveCycleHealthState(["action"], true, false, 0)).toBe("error");
  });

  it("returns error when smoke check failed", () => {
    expect(deriveCycleHealthState(["observation"], false, true, 0)).toBe("error");
  });

  it("returns warning when event types include error", () => {
    expect(deriveCycleHealthState(["action", "error"], false, false, 0)).toBe("warning");
  });

  it("returns warning when needs attention count > 0", () => {
    expect(deriveCycleHealthState(["observation"], false, false, 2)).toBe("warning");
  });

  it("prefers error over warning when both apiRestarted and error events", () => {
    expect(deriveCycleHealthState(["error"], true, false, 1)).toBe("error");
  });
});

// ─── Unit: buildCycleLabel ───────────────────────────────────────────────────

describe("buildCycleLabel", () => {
  const base: MonitorCycleSummary = {
    cycleId: "c1",
    startedAt: new Date().toISOString(),
    endedAt: null,
    healthState: "healthy",
    mergedCount: 0,
    startedCount: 0,
    refillCount: 0,
    needsAttentionCount: 0,
    apiRestarted: false,
    smokeCheckFailed: false,
    issueNumbers: [],
    label: "",
  };

  it("returns 'no actions' for an empty cycle", () => {
    expect(buildCycleLabel(base)).toBe("no actions");
  });

  it("includes merged count", () => {
    expect(buildCycleLabel({ ...base, mergedCount: 2 })).toBe("2 merged");
  });

  it("includes started count", () => {
    expect(buildCycleLabel({ ...base, startedCount: 1 })).toBe("1 started");
  });

  it("includes refill count", () => {
    expect(buildCycleLabel({ ...base, refillCount: 3 })).toBe("3 refilled");
  });

  it("includes needs attention count", () => {
    expect(buildCycleLabel({ ...base, needsAttentionCount: 1 })).toBe("1 need attention");
  });

  it("includes API restart flag", () => {
    expect(buildCycleLabel({ ...base, apiRestarted: true })).toBe("API restart");
  });

  it("includes smoke check failed flag", () => {
    expect(buildCycleLabel({ ...base, smokeCheckFailed: true })).toBe("smoke check failed");
  });

  it("combines all fields", () => {
    const label = buildCycleLabel({
      ...base,
      apiRestarted: true,
      smokeCheckFailed: true,
      mergedCount: 2,
      startedCount: 1,
      refillCount: 1,
      needsAttentionCount: 2,
    });
    expect(label).toBe("API restart, smoke check failed, 2 merged, 1 started, 1 refilled, 2 need attention");
  });
});

// ─── Integration: listMonitorCycles + API endpoint ───────────────────────────

describe("listMonitorCycles service", () => {
  it("groups events by cycleId and returns cycle summaries", async () => {
    const { db } = createTestApp();
    const projectId = await createProject(db);

    const t = (offsetMs: number) => new Date(Date.now() - offsetMs).toISOString();

    await db.insert(schema.boardHealthEvents).values([
      { id: randomUUID(), projectId, cycleId: "cycle-A", eventType: "cycle_start", summary: "Cycle started", createdAt: t(5000) },
      { id: randomUUID(), projectId, cycleId: "cycle-A", eventType: "action", category: "merge", summary: "Merged workspace #10", issueNumber: 10, createdAt: t(4000) },
      { id: randomUUID(), projectId, cycleId: "cycle-A", eventType: "action", category: "launch", summary: "Started workspace #11", issueNumber: 11, createdAt: t(3000) },
      { id: randomUUID(), projectId, cycleId: "cycle-A", eventType: "cycle_end", summary: "Cycle ended", createdAt: t(2000) },
      { id: randomUUID(), projectId, cycleId: "cycle-B", eventType: "cycle_start", summary: "Cycle started", createdAt: t(1000) },
      { id: randomUUID(), projectId, cycleId: "cycle-B", eventType: "observation", summary: "No workspaces need attention", createdAt: t(500) },
    ]);

    const cycles = await listMonitorCycles(projectId, { limit: 10 }, db);

    // Most recent cycle first
    expect(cycles[0].cycleId).toBe("cycle-B");
    expect(cycles[1].cycleId).toBe("cycle-A");

    const cycleA = cycles[1];
    expect(cycleA.mergedCount).toBe(1);
    expect(cycleA.startedCount).toBe(1);
    expect(cycleA.issueNumbers).toEqual([10, 11]);
    expect(cycleA.healthState).toBe("healthy");
  });

  it("marks cycle as warning when it has error events", async () => {
    const { db } = createTestApp();
    const projectId = await createProject(db);

    await db.insert(schema.boardHealthEvents).values([
      { id: randomUUID(), projectId, cycleId: "c-err", eventType: "cycle_start", summary: "Cycle started", createdAt: new Date(Date.now() - 2000).toISOString() },
      { id: randomUUID(), projectId, cycleId: "c-err", eventType: "error", category: "launch", summary: "Agent failed to launch", createdAt: new Date(Date.now() - 1000).toISOString() },
    ]);

    const cycles = await listMonitorCycles(projectId, {}, db);
    expect(cycles[0].healthState).toBe("warning");
  });

  it("flags apiRestarted when server restart event present", async () => {
    const { db } = createTestApp();
    const projectId = await createProject(db);

    await db.insert(schema.boardHealthEvents).values([
      { id: randomUUID(), projectId, cycleId: "c-restart", eventType: "error", category: "server", summary: "Server restarted after crash", createdAt: new Date().toISOString() },
    ]);

    const cycles = await listMonitorCycles(projectId, {}, db);
    expect(cycles[0].apiRestarted).toBe(true);
    expect(cycles[0].healthState).toBe("error");
  });

  it("flags smokeCheckFailed for smoke_check error", async () => {
    const { db } = createTestApp();
    const projectId = await createProject(db);

    await db.insert(schema.boardHealthEvents).values([
      { id: randomUUID(), projectId, cycleId: "c-smoke", eventType: "error", category: "smoke_check", summary: "Frontend smoke check timed out despite board content rendered", createdAt: new Date().toISOString() },
    ]);

    const cycles = await listMonitorCycles(projectId, {}, db);
    expect(cycles[0].smokeCheckFailed).toBe(true);
    expect(cycles[0].healthState).toBe("error");
  });

  it("returns at most limit cycles", async () => {
    const { db } = createTestApp();
    const projectId = await createProject(db);

    for (let i = 0; i < 5; i++) {
      await db.insert(schema.boardHealthEvents).values({
        id: randomUUID(),
        projectId,
        cycleId: `cycle-${i}`,
        eventType: "cycle_start",
        summary: "Cycle started",
        createdAt: new Date(Date.now() - i * 1000).toISOString(),
      });
    }

    const cycles = await listMonitorCycles(projectId, { limit: 3 }, db);
    expect(cycles).toHaveLength(3);
  });

  it("isolates cycles by project", async () => {
    const { db } = createTestApp();
    const projectId = await createProject(db);
    const otherId = await createProject(db, "Other");

    await db.insert(schema.boardHealthEvents).values([
      { id: randomUUID(), projectId, cycleId: "mine", eventType: "cycle_start", summary: "Mine", createdAt: new Date().toISOString() },
      { id: randomUUID(), projectId: otherId, cycleId: "theirs", eventType: "cycle_start", summary: "Theirs", createdAt: new Date().toISOString() },
    ]);

    const cycles = await listMonitorCycles(projectId, {}, db);
    expect(cycles.every((c) => c.cycleId === "mine")).toBe(true);
    expect(cycles.find((c) => c.cycleId === "theirs")).toBeUndefined();
  });
});

describe("GET /api/projects/:id/monitor-cycles", () => {
  it("returns cycle summaries via HTTP", async () => {
    const { app, db } = createTestApp();
    const projectId = await createProject(db);

    await db.insert(schema.boardHealthEvents).values([
      {
        id: randomUUID(),
        projectId,
        cycleId: "http-cycle-1",
        eventType: "action",
        category: "merge",
        issueNumber: 5,
        summary: "Merged workspace #5",
        createdAt: new Date(Date.now() - 2000).toISOString(),
      },
      {
        id: randomUUID(),
        projectId,
        cycleId: "http-cycle-1",
        eventType: "cycle_end",
        summary: "Cycle ended",
        createdAt: new Date(Date.now() - 1000).toISOString(),
      },
    ]);

    const res = await app.request(`/api/projects/${projectId}/monitor-cycles`);
    expect(res.status).toBe(200);
    const body = await res.json() as MonitorCycleSummary[];
    expect(body).toHaveLength(1);
    expect(body[0].cycleId).toBe("http-cycle-1");
    expect(body[0].mergedCount).toBe(1);
    expect(body[0].issueNumbers).toContain(5);
    expect(body[0].healthState).toBe("healthy");
    expect(body[0].label).toBe("1 merged");
  });

  it("respects limit query param", async () => {
    const { app, db } = createTestApp();
    const projectId = await createProject(db);

    for (let i = 0; i < 10; i++) {
      await db.insert(schema.boardHealthEvents).values({
        id: randomUUID(),
        projectId,
        cycleId: `http-c-${i}`,
        eventType: "cycle_start",
        summary: "Started",
        createdAt: new Date(Date.now() - i * 1000).toISOString(),
      });
    }

    const res = await app.request(`/api/projects/${projectId}/monitor-cycles?limit=4`);
    expect(res.status).toBe(200);
    const body = await res.json() as MonitorCycleSummary[];
    expect(body).toHaveLength(4);
  });
});
