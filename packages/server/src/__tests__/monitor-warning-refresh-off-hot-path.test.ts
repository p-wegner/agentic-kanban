// #349: the health-warning refresh (`scanDirtyMainCheckouts` + `scanAutodriveStallWarnings`) is
// PURELY DIAGNOSTIC — nothing in the monitor cycle reads its output — yet it was the single
// slowest phase of the cycle at a measured 203-265s, awaited on the critical path, on a board
// whose cycles run back-to-back (measured 5-8s gaps). It was additionally kicked unguarded every
// 30s by `syncMonitorState`, with no re-entrancy guard, so several copies overlapped permanently.
//
// These tests lock the two properties that fix costs nothing to keep and everything to lose:
//   1. a cycle COMPLETES while the diagnostic scan is still in flight (not awaited), and
//   2. the scan is single-flight and rate-limited, so it cannot pile up on itself.
// Plus the invariant that made the old code order-sensitive: auto-start skip warnings and scanned
// warnings must coexist, whichever lands last.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import { preferences, projects, projectStatuses } from "@agentic-kanban/shared/schema";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../db/index.js", () => ({
  get db() {
    return dbHolder.current;
  },
}));

// A scan that never resolves on its own: the cycle must not be waiting for it.
const scanGate = vi.hoisted(() => ({
  release: null as null | (() => void),
  calls: 0,
}));
vi.mock("../services/dirty-main-checkout.js", () => ({
  scanDirtyMainCheckouts: vi.fn(() => {
    scanGate.calls += 1;
    return new Promise((resolve) => {
      scanGate.release = () => resolve([]);
    });
  }),
}));
vi.mock("../services/autodrive-stall-warning.service.js", () => ({
  scanAutodriveStallWarnings: vi.fn(async () => []),
  buildAutoStartSkipWarnings: vi.fn(() => []),
}));
vi.mock("../services/stale-dev-processes.js", () => ({
  snapshotAndCleanStaleDevProcesses: vi.fn(async () => ({
    processes: [], listeners: [], activeWorkspaces: [], kept: [], cleaned: [],
  })),
}));

import { createMonitorSetup } from "../startup/monitor-setup.js";

const PROJECT_ID = "proj-warning-hot-path";
const NOW = "2026-06-15T00:00:00.000Z";

type TestDb = ReturnType<typeof createTestDb>["db"];
let db: TestDb;

async function seedBoard() {
  await db.insert(projects).values({ id: PROJECT_ID, name: "P", repoPath: "/tmp/p", defaultBranch: "master", createdAt: NOW, updatedAt: NOW });
  const lanes = ["Backlog", "Todo", "In Progress", "In Review", "Done", "Cancelled"];
  for (const name of lanes) {
    await db.insert(projectStatuses).values({ id: `status-${name.replace(/\s/g, "-").toLowerCase()}`, projectId: PROJECT_ID, name, sortOrder: lanes.indexOf(name), createdAt: NOW });
  }
  await db.insert(preferences).values({ key: `board_autodrive_${PROJECT_ID}`, value: "true", updatedAt: NOW });
}

function buildMonitor() {
  const boardEvents = {
    addInvalidationListener: () => {},
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
    serverPort: 39997,
    reviewSessionIds: new Set<string>(),
    fixAndMergeSessionIds: new Set<string>(),
  });

  const handlers: Record<string, (c: { json: (v: unknown) => unknown }) => unknown> = {};
  const fakeApp = {
    post: (path: string, h: (c: { json: (v: unknown) => unknown }) => unknown) => { handlers[path] = h; },
    get: (path: string, h: (c: { json: (v: unknown) => unknown }) => unknown) => { handlers[path] = h; },
  } as unknown as Parameters<typeof setup.setupMonitorRoutes>[0];
  setup.setupMonitorRoutes(fakeApp);

  // The monitor-status handler now reads `c.req` (verbose query, If-None-Match) and
  // returns a raw `Response` (conditional GET) — the fake context mirrors that.
  const statusCtx = { json: (v: unknown) => v, req: { query: () => undefined, header: () => undefined } };
  return {
    setup,
    triggerCycle: () => handlers["/api/internal/monitor-run"]({ json: (v: unknown) => v }),
    status: async () => {
      const res = await handlers["/api/internal/monitor-status"](statusCtx as never);
      return (res instanceof Response ? await res.json() : res) as Record<string, unknown>;
    },
  };
}

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, timeoutMs = 5000) {
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
  scanGate.calls = 0;
  scanGate.release = null;
});

afterEach(() => {
  scanGate.release?.();
  activeSetup?.stop();
  activeSetup = null;
});

describe("monitor health-warning refresh is off the cycle's critical path (#349)", () => {
  it("completes a cycle while the diagnostic scan is still in flight, and never runs two scans at once", async () => {
    await seedBoard();
    const { setup, triggerCycle, status } = buildMonitor();
    activeSetup = setup;

    // The boot-time `syncMonitorState()` already fires one scan; it is deliberately left hanging.
    await waitUntil(() => scanGate.calls >= 1);

    triggerCycle();
    // The cycle must reach `lastRun` — i.e. finish — with the scan still unresolved. Before #349
    // this awaited the scan and would hang here forever.
    let done = false;
    // Budget deliberately generous: a cycle's teardown now takes a closing environmental CONTROL
    // spawn (#368) — a real `git --version`, MEASURED between 68ms and 10203ms on this machine — so a
    // two-second budget here would be exactly the kind of load-sensitive assertion #368 is about.
    for (let i = 0; i < 2000 && !done; i++) {
      await flush(10);
      const s = await status();
      done = s.lastRun !== null && s.currentCycle === null;
    }
    expect(done).toBe(true);

    // Single-flight: the hanging scan blocks any further scan, so no second call was made even
    // though a cycle ran and `syncMonitorState`'s 30s timer shares the same entry point.
    expect(scanGate.calls).toBe(1);
  });

  it("rate-limits the scan: a second cycle right after a completed scan does not rescan", async () => {
    await seedBoard();
    const { setup, triggerCycle, status } = buildMonitor();
    activeSetup = setup;

    await waitUntil(() => scanGate.release !== null);
    scanGate.release?.();
    scanGate.release = null;
    await flush(20);
    expect(scanGate.calls).toBe(1);

    triggerCycle();
    let done = false;
    // Budget deliberately generous: a cycle's teardown now takes a closing environmental CONTROL
    // spawn (#368) — a real `git --version`, MEASURED between 68ms and 10203ms on this machine — so a
    // two-second budget here would be exactly the kind of load-sensitive assertion #368 is about.
    for (let i = 0; i < 2000 && !done; i++) {
      await flush(10);
      const s = await status();
      done = s.lastRun !== null && s.currentCycle === null;
    }
    expect(done).toBe(true);
    // Well inside HEALTH_WARNING_REFRESH_INTERVAL_MS (10 min), so still exactly one scan.
    expect(scanGate.calls).toBe(1);
  });
});
