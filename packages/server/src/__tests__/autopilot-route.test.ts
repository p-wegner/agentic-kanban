// #1102 — GET /api/projects/:id/autopilot, and PARITY with what the monitor then does.
//
// The chip's "+N next cycle" is only worth showing if it is the number `runAutoStart` acts on.
// Each scenario seeds one real project, reads the route, then runs `runAutoStart` over the SAME
// database with the same capacity fixture and counts the workspace launches it attempts.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const { db } = createTestDb();
  return { db, writeDb: db };
});

import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import type { MachineCapacitySnapshot } from "@agentic-kanban/shared/lib/machine-capacity";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import type { AutopilotStatusResponse } from "@agentic-kanban/shared/types";
import { db } from "../db/index.js";
import { createBoardMonitorRoute } from "../routes/board-monitor.js";
import { getAllPreferences } from "../repositories/preferences.repository.js";
import { resolveStartPolicy } from "../services/start-policy.service.js";
import { runAutoStart } from "../startup/monitor-auto-start.js";
import { openFileContentionGate } from "../startup/monitor-file-contention.js";

const roomy = { tier: "0", hold: false, reason: "test fixture", freeGb: 99 } as MachineCapacitySnapshot;
const headroom = (n: number) =>
  ({ tier: "1", hold: false, canStartAnother: true, headroomProcesses: n, thrashing: "none", reason: "test fixture" }) as MachineCapacitySnapshot;

interface Seed {
  startMode?: "manual" | "monitor" | "conductor";
  bullseye?: Record<string, unknown>;
  running?: number;
  inProgressUnstarted?: number;
  todo?: number;
  /** Todo tickets that already have an open workspace — never ready. */
  todoWithOpenWorkspace?: number;
}

let issueCounter = 0;

async function seed(opts: Seed): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: `autopilot-${projectId.slice(0, 6)}`, repoPath: `/tmp/autopilot-${projectId}`, repoName: "r",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const statusIds: Record<string, string> = {};
  for (const [i, name] of ["Backlog", "Todo", "In Progress", "Done"].entries()) {
    statusIds[name] = randomUUID();
    await db.insert(projectStatuses).values({ id: statusIds[name], projectId, name, sortOrder: i, isDefault: i === 0, createdAt: now });
  }
  const addIssue = async (status: string, workspaceStatus?: string) => {
    const id = randomUUID();
    issueCounter++;
    await db.insert(issues).values({
      id, issueNumber: issueCounter, title: `Ticket ${issueCounter}`, issueType: "task", sortOrder: issueCounter, priority: "medium",
      statusId: statusIds[status], projectId, createdAt: now, updatedAt: now, statusChangedAt: now,
    });
    if (workspaceStatus) {
      await db.insert(workspaces).values({
        id: randomUUID(), issueId: id, branch: `feature/t-${issueCounter}`, workingDir: `/tmp/autopilot/${issueCounter}`,
        baseBranch: "main", status: workspaceStatus, createdAt: now, updatedAt: now,
      });
    }
  };
  for (let i = 0; i < (opts.running ?? 0); i++) await addIssue("In Progress", "active");
  for (let i = 0; i < (opts.inProgressUnstarted ?? 0); i++) await addIssue("In Progress");
  for (let i = 0; i < (opts.todo ?? 0); i++) await addIssue("Todo");
  for (let i = 0; i < (opts.todoWithOpenWorkspace ?? 0); i++) await addIssue("Todo", "idle");

  await db.insert(preferences).values({ key: `start_mode_${projectId}`, value: opts.startMode ?? "monitor" });
  if (opts.bullseye) {
    await db.insert(preferences).values({ key: `board_strategy_${projectId}`, value: JSON.stringify({ version: 1, segments: [], ...opts.bullseye }) });
  }
  return projectId;
}

async function readAutopilot(projectId: string, capacity: MachineCapacitySnapshot): Promise<{ status: number; body: AutopilotStatusResponse }> {
  const app = new Hono();
  app.route("/api/projects", createBoardMonitorRoute(db as never, {
    readMachineCapacity: async () => capacity,
    canDispatch: async () => ({ available: true }),
    hasFleetOverflowCapacity: async () => false,
    quiesceHostHeld: async () => false,
  }));
  const res = await app.request(`/api/projects/${projectId}/autopilot`);
  return { status: res.status, body: (await res.json()) as AutopilotStatusResponse };
}

/** What the monitor ACTUALLY does for this project on a cycle with the same inputs. */
async function monitorStarts(projectId: string, capacity: MachineCapacitySnapshot): Promise<number> {
  const prefMap = toPrefMap(await getAllPreferences(db as never));
  const launches = vi.fn(async () => ({ ok: true, status: 202, json: async () => ({ jobId: "job" }), text: async () => "" }) as unknown as Response);
  vi.stubGlobal("fetch", launches);
  await runAutoStart(prefMap, {
    serverPort: 1,
    boardEvents: { broadcast: vi.fn() } as never,
    logMonitorAction: vi.fn(),
    // Every seeded project shares this database: scope the cycle to the one under test.
    allowProject: (id) => id === projectId && resolveStartPolicy(prefMap, id).autoStartUnblocked,
    isAutoDrivenProject: (id) => resolveStartPolicy(prefMap, id).mode !== "manual",
    buildContentionGate: async () => openFileContentionGate(),
    canDispatch: async () => ({ available: true }),
    readMachineCapacity: async () => capacity,
    hostOverflowHasFleetCapacity: async () => false,
    orderStartCandidates: async () => {},
    buildHarnessGate: async () => ({ slots: 0, sharePct: 100, used: 0, isHarness: () => false, allows: () => true, noteStarted: () => {} }),
  });
  return launches.mock.calls.length;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/projects/:id/autopilot (#1102)", () => {
  it("free slots: +min(free WIP, starts per cycle, ready tickets) — and the monitor starts exactly that many", async () => {
    const projectId = await seed({ bullseye: { activeAgentsTarget: 4, maxNewStartsPerCycle: 2 }, running: 1, todo: 3, todoWithOpenWorkspace: 1 });
    const { status, body } = await readAutopilot(projectId, roomy);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      startMode: "monitor", autoStart: true, running: 1, limit: 4, limitConfigured: true, effectiveLimit: 4,
      startsPerCycle: 2, eligibleCount: 3, slots: 2, willStartNextCycle: 2, holdReason: null,
    });
    expect(await monitorStarts(projectId, roomy)).toBe(body.willStartNextCycle);
  });

  it("WIP full: holds with wip_full, and the monitor starts nothing", async () => {
    const projectId = await seed({ bullseye: { activeAgentsTarget: 2, maxNewStartsPerCycle: 2 }, running: 2, todo: 2 });
    const { body } = await readAutopilot(projectId, roomy);
    expect(body).toMatchObject({ running: 2, limit: 2, willStartNextCycle: 0, holdReason: "wip_full", eligibleCount: 2 });
    expect(await monitorStarts(projectId, roomy)).toBe(0);
  });

  it("machine clamp: headroom for one more agent lowers the effective limit and the prediction with it", async () => {
    const capacity = headroom(1);
    const projectId = await seed({ bullseye: { activeAgentsTarget: 5, maxNewStartsPerCycle: 5 }, running: 1, todo: 4 });
    const { body } = await readAutopilot(projectId, capacity);
    expect(body).toMatchObject({ limit: 5, effectiveLimit: 2, willStartNextCycle: 1, holdReason: null });
    expect(await monitorStarts(projectId, capacity)).toBe(1);
  });

  it("machine full: zero headroom holds as machine_full", async () => {
    const capacity = headroom(0);
    const projectId = await seed({ bullseye: { activeAgentsTarget: 4, maxNewStartsPerCycle: 2 }, running: 2, todo: 2 });
    const { body } = await readAutopilot(projectId, capacity);
    expect(body).toMatchObject({ running: 2, effectiveLimit: 2, willStartNextCycle: 0, holdReason: "machine_full" });
    expect(await monitorStarts(projectId, capacity)).toBe(0);
  });

  it("backfill and pull share one start cap, exactly as the two monitor passes do", async () => {
    const projectId = await seed({ bullseye: { activeAgentsTarget: 6, maxNewStartsPerCycle: 3 }, inProgressUnstarted: 2, todo: 3 });
    const { body } = await readAutopilot(projectId, roomy);
    expect(body).toMatchObject({ running: 0, eligibleCount: 5, willStartNextCycle: 3 });
    expect(await monitorStarts(projectId, roomy)).toBe(3);
  });

  it("manual: nothing auto-starts, whatever room there is", async () => {
    const projectId = await seed({ startMode: "manual", bullseye: { activeAgentsTarget: 4 }, todo: 2 });
    const { body } = await readAutopilot(projectId, roomy);
    expect(body).toMatchObject({ startMode: "manual", autoStart: false, willStartNextCycle: 0, holdReason: "manual_mode" });
    expect(body.slots).toBeGreaterThan(0);
    expect(await monitorStarts(projectId, roomy)).toBe(0);
  });

  it("conductor: the out-of-process loop drives, so the in-process prediction is 0 and says why", async () => {
    const projectId = await seed({ startMode: "conductor", todo: 2 });
    const { body } = await readAutopilot(projectId, roomy);
    expect(body).toMatchObject({ startMode: "conductor", autoStart: false, willStartNextCycle: 0, holdReason: "conductor_mode" });
    expect(await monitorStarts(projectId, roomy)).toBe(0);
  });

  it("no ready tickets: room but nothing to start", async () => {
    const projectId = await seed({ bullseye: { activeAgentsTarget: 3 }, todoWithOpenWorkspace: 1 });
    const { body } = await readAutopilot(projectId, roomy);
    expect(body).toMatchObject({ eligibleCount: 0, willStartNextCycle: 0, holdReason: "no_ready_tickets" });
    expect(await monitorStarts(projectId, roomy)).toBe(0);
  });

  it("reports the default limit as not configured when the project has no Bullseye target", async () => {
    const projectId = await seed({ todo: 1 });
    const { body } = await readAutopilot(projectId, roomy);
    expect(body.limitConfigured).toBe(false);
    expect(body.limit).toBeGreaterThanOrEqual(1);
  });

  it("carries the effective auto-merge answer — a project opt-out wins over the global switch", async () => {
    const projectId = await seed({ bullseye: { activeAgentsTarget: 2 } });
    await db.insert(preferences).values([
      { key: "auto_merge", value: "true" },
      { key: "merge_strategy", value: "monitor" },
      { key: `auto_merge_disabled_${projectId}`, value: "true" },
    ]).onConflictDoNothing();
    const { body } = await readAutopilot(projectId, roomy);
    expect(body.autoMerge).toEqual({ enabled: false, source: "project_disabled" });
  });

  it("404s for an unknown project", async () => {
    const { status } = await readAutopilot(randomUUID(), roomy);
    expect(status).toBe(404);
  });
});
