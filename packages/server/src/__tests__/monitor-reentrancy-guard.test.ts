// @covers monitor-orchestration.guard.re-entrancy-and-maintenance [state-transition, regression, config]
//
// The module's defining safety invariant: NEVER double-drive a board. Two concurrent
// monitor cycles must not each POST a workspace for the SAME unblocked issue (that would
// create two conflicting worktrees for one ticket). And a configured maintenance window
// must suppress every disruptive action WITHOUT disabling the monitor.
//
// We exercise the REAL re-entrancy guard + maintenance check inside `createMonitorSetup`'s
// `runMonitorCycle` closure, against a REAL in-memory migrated DB (so all the cycle's
// queries behave exactly as in production). The only seam we stub is the workspace-start
// PORT: auto-start POSTs to `/api/workspaces` via global `fetch`, so we stub `fetch` and
// count how many starts fire for the unblocked issue. The cycle is driven through the real
// `POST /api/internal/monitor-run` route handler (which calls `runMonitorCycle(true)`),
// mirroring how an external trigger arrives.
//
// Mutation expectations (reasoned + relied on by the reviewer):
//  - Remove the re-entrancy lock (`if (cycleRunning) { rerunRequested = true; return; }`):
//    two overlapping triggers each run auto-start concurrently, both see no open workspace,
//    and both POST → 2 starts for one issue → the re-entrancy test goes RED.
//  - Remove the maintenance suppression (`if (isInMaintenanceWindow(...)) return`): the
//    cycle proceeds to auto-start during the window → a start fires → the maintenance test
//    goes RED.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import { issues, preferences, projects, projectStatuses } from "@agentic-kanban/shared/schema";

// The production singleton `db` is replaced with a per-test in-memory DB via a getter so
// `import { db }` everywhere in the cycle resolves to the test DB (with correct `this`).
const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../db/index.js", () => ({
  get db() {
    return dbHolder.current;
  },
}));

// Heavy / OS-coupled health passes the cycle runs before orchestration — neutralised so the
// test exercises only the guard + auto-start path deterministically.
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

const PROJECT_ID = "proj-reentrancy";
const ISSUE_ID = "issue-unblocked";
const NOW = "2026-06-15T00:00:00.000Z";

type TestDb = ReturnType<typeof createTestDb>["db"];
let db: TestDb;

/** A minimal board: project + the standard status lanes + ONE unblocked Todo issue. */
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

/** Build the monitor setup and capture the internal-monitor-run route handler. */
function buildMonitor() {
  const listeners: Array<() => void> = [];
  const boardEvents = {
    addInvalidationListener: (l: () => void) => listeners.push(l),
    removeInvalidationListener: () => {},
    // No-op broadcast: avoid re-entrant invalidation triggers so the test stays deterministic.
    broadcast: vi.fn(),
  } as unknown as Parameters<typeof createMonitorSetup>[0]["boardEvents"];

  const sessionManager = {
    isProcessAlive: vi.fn(() => true),
    stopSession: vi.fn(),
  } as unknown as Parameters<typeof createMonitorSetup>[0]["sessionManager"];

  const setup = createMonitorSetup({
    sessionManager,
    boardEvents,
    serverPort: 39999,
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
  return { setup, triggerCycle };
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

describe("monitor re-entrancy guard — never double-drive the same unblocked issue", () => {
  it("two overlapping cycles POST a workspace at most ONCE for one unblocked issue", async () => {
    await seedBoard();
    // Per-project hands-off mode enables auto-start without flipping the global toggle.
    await setPref("nudge_wip_limit", "5");

    // The workspace-start port: block the first POST mid-flight so a second trigger can
    // arrive WHILE the first cycle is still inside auto-start (true overlap). Count starts
    // per issue.
    const postedIssueIds: string[] = [];
    let releaseFetch!: () => void;
    const gate = new Promise<void>((r) => { releaseFetch = r; });
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const body = JSON.parse(opts.body) as { issueId: string };
      postedIssueIds.push(body.issueId);
      await gate;
      return { ok: true, json: async () => ({ id: `ws-${postedIssueIds.length}` }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { setup, triggerCycle } = buildMonitor();
    activeSetup = setup;
    // Enable hands-off AFTER construction so the build-time syncMonitorState does not auto-run
    // a cycle; the forced route trigger below reads this fresh.
    await setPref(`board_autodrive_${PROJECT_ID}`, "true");

    // Trigger #1: runs until it parks inside the (gated) start POST.
    triggerCycle();
    await waitUntil(() => fetchMock.mock.calls.length >= 1);

    // Trigger #2 arrives mid-cycle. With the re-entrancy guard it is coalesced (no second
    // concurrent auto-start). Give a generous window for a SECOND start to appear if the
    // guard were absent.
    triggerCycle();
    await flush(150);

    releaseFetch();
    await flush(150);

    // The defining invariant: exactly one start for the unblocked issue.
    expect(postedIssueIds.filter((id) => id === ISSUE_ID)).toHaveLength(1);
  });
});

describe("monitor maintenance window — suppresses all disruptive actions", () => {
  it("starts NOTHING while a maintenance window is active", async () => {
    await seedBoard();
    await setPref("nudge_wip_limit", "5");

    const postedIssueIds: string[] = [];
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      postedIssueIds.push((JSON.parse(opts.body) as { issueId: string }).issueId);
      return { ok: true, json: async () => ({ id: "ws-x" }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { setup, triggerCycle } = buildMonitor();
    activeSetup = setup;
    await setPref(`board_autodrive_${PROJECT_ID}`, "true");
    // Maintenance window open, ending well in the future. (isInMaintenanceWindow reads real
    // Date.now() — there is no nowOverride seam on this code path — so we anchor the end an
    // hour ahead of the real clock; deterministic without faking timers.)
    await setPref("monitor_maintenance_window_enabled", "true");
    await setPref("monitor_maintenance_window_end", new Date(Date.now() + 60 * 60 * 1000).toISOString());

    triggerCycle();
    await flush(200);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(postedIssueIds).toHaveLength(0);
  });
});
