// #917 — GET /api/projects/:id/board-monitor/next: read-only top-N ranked start candidates.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { describe, it, expect } from "vitest";
import { issues, preferences, projectStatuses, projects } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createBoardMonitorRoute } from "../routes/board-monitor.js";

async function seedProject(db: TestDb): Promise<{ projectId: string; todoStatusId: string }> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const todoStatusId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: "/tmp/board-monitor-next-repo", repoName: "board-monitor-next-repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: todoStatusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now,
  });
  return { projectId, todoStatusId };
}

async function seedIssue(
  db: TestDb,
  args: { projectId: string; statusId: string; issueNumber: number; title: string; priority?: string },
): Promise<string> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(issues).values({
    id, issueNumber: args.issueNumber, title: args.title, statusId: args.statusId, projectId: args.projectId,
    priority: args.priority ?? "medium", createdAt: now, updatedAt: now, statusChangedAt: now,
  });
  return id;
}

function makeApp(db: TestDb) {
  const app = new Hono();
  app.route("/api/projects", createBoardMonitorRoute(db as never));
  return app;
}

describe("GET /api/projects/:id/board-monitor/next", () => {
  it("returns candidates ranked by score, highest first", async () => {
    const { db } = createTestDb();
    const { projectId, todoStatusId } = await seedProject(db);
    await seedIssue(db, { projectId, statusId: todoStatusId, issueNumber: 1, title: "Low leaf", priority: "low" });
    await seedIssue(db, { projectId, statusId: todoStatusId, issueNumber: 2, title: "High prio", priority: "high" });

    const app = makeApp(db);
    const res = await app.request(`/api/projects/${projectId}/board-monitor/next`);
    expect(res.status).toBe(200);
    const body = await res.json() as { projectId: string; candidates: Array<{ title: string; score: { score: number } }> };
    expect(body.projectId).toBe(projectId);
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates[0].title).toBe("High prio");
    expect(body.candidates[0].score.score).toBeGreaterThan(body.candidates[1].score.score);
  });

  it("respects the limit query param", async () => {
    const { db } = createTestDb();
    const { projectId, todoStatusId } = await seedProject(db);
    for (let i = 1; i <= 5; i++) {
      await seedIssue(db, { projectId, statusId: todoStatusId, issueNumber: i, title: `Ticket ${i}` });
    }

    const app = makeApp(db);
    const res = await app.request(`/api/projects/${projectId}/board-monitor/next?limit=2`);
    const body = await res.json() as { candidates: unknown[] };
    expect(body.candidates).toHaveLength(2);
  });

  it("does not persist a score (read-only preview)", async () => {
    const { db } = createTestDb();
    const { projectId, todoStatusId } = await seedProject(db);
    const issueId = await seedIssue(db, { projectId, statusId: todoStatusId, issueNumber: 1, title: "Solo" });

    const app = makeApp(db);
    await app.request(`/api/projects/${projectId}/board-monitor/next`);

    const [row] = await db.select({ lastStartScore: issues.lastStartScore }).from(issues).where(eq(issues.id, issueId));
    expect(row.lastStartScore).toBeNull();
  });

  it("returns an empty candidate list when the project has no Todo status", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId, name: "NoTodo", repoPath: "/tmp/no-todo-repo", repoName: "no-todo-repo",
      defaultBranch: "main", createdAt: now, updatedAt: now,
    });

    const app = makeApp(db);
    const res = await app.request(`/api/projects/${projectId}/board-monitor/next`);
    const body = await res.json() as { candidates: unknown[] };
    expect(body.candidates).toEqual([]);
  });
});

// #1029 - the Conductor reads its capacity brake off this payload once per cycle.
describe("GET /api/projects/:id/monitor-tunables - capacity (#1029)", () => {
  it("a saturated host yields capacity.hold=true with zero new starts and the measured numbers", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    const app = new Hono();
    app.route("/api/projects", createBoardMonitorRoute(db as never, {
      readMachineCapacity: async () => ({ tier: "1", hold: true, canStartAnother: false, headroomProcesses: 0, thrashing: "heavy" }),
    }));
    const res = await app.request(`/api/projects/${projectId}/monitor-tunables`);
    expect(res.status).toBe(200);
    const body = await res.json() as { capacity: { hold: boolean; tier: string; maxNewStarts: number | null; reason: string } };
    expect(body.capacity.hold).toBe(true);
    expect(body.capacity.tier).toBe("1");
    expect(body.capacity.maxNewStarts).toBe(0);
    expect(body.capacity.reason).toContain("0 headroom process(es)");
    expect(body.capacity.reason).toContain("thrashing=heavy");
  });

  it("an unsaturated host leaves the tunables untouched and caps new starts at the measured headroom", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    const app = new Hono();
    app.route("/api/projects", createBoardMonitorRoute(db as never, {
      readMachineCapacity: async () => ({ tier: "1", hold: false, canStartAnother: true, headroomProcesses: 1, thrashing: "none" }),
    }));
    const res = await app.request(`/api/projects/${projectId}/monitor-tunables`);
    const body = await res.json() as { tunables: { maxNewStartsPerCycle: number; activeAgentsTarget: number }; capacity: { hold: boolean; maxNewStarts: number | null } };
    expect(body.capacity.hold).toBe(false);
    expect(body.capacity.maxNewStarts).toBe(1);
    // No Bullseye seeded: the legacy defaults, exactly as before #1029.
    expect(body.tunables.activeAgentsTarget).toBe(5);
    expect(body.tunables.maxNewStartsPerCycle).toBe(3);
  });

  // #1102: the Bullseye is the one stored WIP. A leftover `wip_limit_<id>` row (the startup
  // migration deletes them) must not steer the read-out, and the payload no longer names a
  // second WIP source.
  it("reports the Bullseye target, ignores a leftover wip_limit_<id> row, and drops wipLimitSource", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    await db.insert(preferences).values([
      { key: `wip_limit_${projectId}`, value: "2" },
      { key: `board_strategy_${projectId}`, value: JSON.stringify({ version: 1, activeAgentsTarget: 6, segments: [] }) },
    ]);
    const app = new Hono();
    app.route("/api/projects", createBoardMonitorRoute(db as never, {
      readMachineCapacity: async () => ({ tier: "1", hold: false, canStartAnother: true, headroomProcesses: 4, thrashing: "none" }),
    }));
    const res = await app.request(`/api/projects/${projectId}/monitor-tunables`);
    const body = await res.json() as { tunables: { activeAgentsTarget: number }; source: string; startPolicy: { wip: { activeAgentsTarget: number } } };
    expect(body.tunables.activeAgentsTarget).toBe(6);
    expect("wipLimitSource" in body).toBe(false);
    expect(body.source).toBe("strategy");
    expect(body.startPolicy.wip.activeAgentsTarget).toBe(body.tunables.activeAgentsTarget);
  });
});

// #1127: host disk-health signal carried alongside capacity, so a setup/gate failure with the
// same timestamp as a hardware event reads as "check the machine", not another phantom bug.
describe("GET /api/projects/:id/monitor-tunables - diskHealth (#1127)", () => {
  it("passes through a degraded disk-health read from the injected probe", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    const app = new Hono();
    app.route("/api/projects", createBoardMonitorRoute(db as never, {
      readMachineCapacity: async () => ({ tier: "0", hold: false, reason: "8.0GB free", freeGb: 8 }),
      readDiskHealth: async () => ({
        diskBadBlockEvents: 12,
        ntfsInterruptedWriteEvents: 3,
        windowDays: 7,
        degraded: true,
        reason: "host disk logged 12 bad-block event(s) and 3 NTFS interrupted-write event(s) in the last 7d — a setup/gate failure around the same time may be failing hardware, not the project (#1127)",
      }),
    }));
    const res = await app.request(`/api/projects/${projectId}/monitor-tunables`);
    expect(res.status).toBe(200);
    const body = await res.json() as { diskHealth: { degraded: boolean; diskBadBlockEvents: number; ntfsInterruptedWriteEvents: number } };
    expect(body.diskHealth.degraded).toBe(true);
    expect(body.diskHealth.diskBadBlockEvents).toBe(12);
    expect(body.diskHealth.ntfsInterruptedWriteEvents).toBe(3);
  });

  it("reports null when the probe finds no signal (non-Windows host, or an unreadable event log)", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    const app = new Hono();
    app.route("/api/projects", createBoardMonitorRoute(db as never, {
      readMachineCapacity: async () => ({ tier: "0", hold: false, reason: "8.0GB free", freeGb: 8 }),
      readDiskHealth: async () => null,
    }));
    const res = await app.request(`/api/projects/${projectId}/monitor-tunables`);
    const body = await res.json() as { diskHealth: unknown };
    expect(body.diskHealth).toBeNull();
  });
});
