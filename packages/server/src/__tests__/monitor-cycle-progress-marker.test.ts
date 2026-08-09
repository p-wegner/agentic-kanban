// #208: a long or wedged monitor cycle must be observable via GET /api/internal/monitor-status
// WHILE it is still running, not only once it finishes (`lastRun` is written only in `finally`,
// so a stuck cycle previously looked identical to "never ran" — `lastRun: null` either way).
// `monitorState.currentCycle` is written at the START of the cycle and cleared once it
// completes, so "running for a long time" and "never started" become distinguishable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import { issues, preferences, projects, projectStatuses } from "@agentic-kanban/shared/schema";

const ISSUE_ID = "issue-progress-marker";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../db/index.js", () => ({
  get db() {
    return dbHolder.current;
  },
}));

vi.mock("../services/dirty-main-checkout.js", () => ({
  scanDirtyMainCheckouts: vi.fn(async () => []),
}));
vi.mock("../services/autodrive-stall-warning.service.js", () => ({
  scanAutodriveStallWarnings: vi.fn(async () => []),
}));
vi.mock("../services/stale-dev-processes.js", () => ({
  snapshotAndCleanStaleDevProcesses: vi.fn(async () => ({
    processes: [],
    listeners: [],
    activeWorkspaces: [],
    kept: [],
    cleaned: [],
  })),
}));

import { createMonitorSetup } from "../startup/monitor-setup.js";

const PROJECT_ID = "proj-progress-marker";
const NOW = "2026-06-15T00:00:00.000Z";

type TestDb = ReturnType<typeof createTestDb>["db"];
let db: TestDb;

async function seedBoard() {
  await db.insert(projects).values({ id: PROJECT_ID, name: "P", repoPath: "/tmp/p", defaultBranch: "master", createdAt: NOW, updatedAt: NOW });
  const lanes = ["Backlog", "Todo", "In Progress", "In Review", "Done", "Cancelled"];
  for (const name of lanes) {
    await db.insert(projectStatuses).values({ id: `status-${name.replace(/\s/g, "-").toLowerCase()}`, projectId: PROJECT_ID, name, sortOrder: lanes.indexOf(name), createdAt: NOW });
  }
  await db.insert(issues).values({
    id: ISSUE_ID,
    issueNumber: 1,
    title: "Unblocked ticket",
    description: "do the thing",
    issueType: "task",
    statusId: "status-todo",
    projectId: PROJECT_ID,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function setPref(key: string, value: string) {
  await db.insert(preferences).values({ key, value, updatedAt: NOW }).onConflictDoUpdate({ target: preferences.key, set: { value } });
}

function buildMonitor() {
  const listeners: Array<() => void> = [];
  const boardEvents = {
    addInvalidationListener: (l: () => void) => listeners.push(l),
    removeInvalidationListener: () => {},
    broadcast: vi.fn(),
  } as unknown as Parameters<typeof createMonitorSetup>[0]["boardEvents"];

  const sessionManager = {
    isProcessAlive: vi.fn(() => true),
    stopSession: vi.fn(),
  } as unknown as Parameters<typeof createMonitorSetup>[0]["sessionManager"];

  const setup = createMonitorSetup({
    sessionManager,
    boardEvents,
    serverPort: 39998,
    reviewSessionIds: new Set<string>(),
    fixAndMergeSessionIds: new Set<string>(),
  });

  const handlers: Record<string, (c: { json: (v: unknown) => unknown }) => unknown> = {};
  const fakeApp = {
    post: (path: string, h: (c: { json: (v: unknown) => unknown }) => unknown) => { handlers[path] = h; },
    get: (path: string, h: (c: { json: (v: unknown) => unknown }) => unknown) => { handlers[path] = h; },
  } as unknown as Parameters<typeof setup.setupMonitorRoutes>[0];
  setup.setupMonitorRoutes(fakeApp);

  const triggerCycle = () => handlers["/api/internal/monitor-run"]({ json: (v: unknown) => v });
  const status = () => handlers["/api/internal/monitor-status"]({ json: (v: unknown) => v }) as Promise<Record<string, unknown>>;
  return { setup, triggerCycle, status };
}

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await flush(5);
  }
}

let activeSetup: { stop: () => void } | null = null;

beforeEach(() => {
  ({ db } = createTestDb());
  dbHolder.current = db;
});

afterEach(() => {
  activeSetup?.stop();
  activeSetup = null;
  vi.unstubAllGlobals();
});

describe("monitor cycle progress marker (#208)", () => {
  it("reports currentCycle while a cycle is running, and clears it once done", async () => {
    await seedBoard();
    await setPref("nudge_wip_limit", "5");

    // Gate the auto-start POST so the cycle stays "in flight" long enough to observe status.
    let releaseFetch!: () => void;
    const gate = new Promise<void>((r) => { releaseFetch = r; });
    const fetchMock = vi.fn(async () => {
      await gate;
      return { ok: true, json: async () => ({ id: "ws-x" }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { setup, triggerCycle, status } = buildMonitor();
    activeSetup = setup;
    await setPref(`board_autodrive_${PROJECT_ID}`, "true");

    // No cycle has run yet.
    const beforeStatus = await status();
    expect(beforeStatus.currentCycle).toBeNull();
    expect(beforeStatus.lastRun).toBeNull();

    triggerCycle();
    await waitUntil(() => fetchMock.mock.calls.length >= 1);

    const midStatus = await status();
    expect(midStatus.currentCycle).not.toBeNull();
    expect(typeof (midStatus.currentCycle as { startedAt: string }).startedAt).toBe("string");
    // Still no COMPLETED run recorded — distinguishable from "never ran" via currentCycle above.
    expect(midStatus.lastRun).toBeNull();

    releaseFetch();
    // Poll rather than wait a fixed 150ms: the cycle's teardown now takes a closing environmental
    // CONTROL spawn (#368) — a real `git --version`, MEASURED between 68ms and 10203ms on this
    // machine — and a fixed budget here would be the same load-sensitive assertion #368 is about.
    let afterStatus = await status();
    for (let i = 0; i < 2000 && afterStatus.currentCycle !== null; i++) {
      await flush(10);
      afterStatus = await status();
    }
    expect(afterStatus.currentCycle).toBeNull();
    expect(afterStatus.lastRun).not.toBeNull();
  });
});
