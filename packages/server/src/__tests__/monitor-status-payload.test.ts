/**
 * 2026-08-11 perf audit (G5) — GET /api/internal/monitor-status payload diet.
 *
 * The endpoint shipped 36-111KB every 30s to every open tab, always 200 (never 304),
 * while the client reads only `{at, kept, cleaned}` off the resource snapshot (at most
 * 3 items each — `client/src/lib/monitor-popover.ts` / `MonitorSections.tsx`) and never
 * reads `lastCyclePhaseTimings`. These tests pin:
 *   1. the default payload excludes the heavy fields (full snapshot, phase timings),
 *   2. `?verbose=1` still serves everything,
 *   3. an unchanged status answers a conditional GET with a bodyless 304.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { createTestDb } from "./helpers/test-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../db/index.js", () => ({
  get db() {
    return dbHolder.current;
  },
}));

import { setupMonitorRoutes, type MonitorState } from "../startup/monitor-setup.js";
import { invalidatePreferencesCache } from "../repositories/preferences.repository.js";

type Handler = (c: unknown) => Promise<Response> | Response | unknown;

function decision(i: number) {
  return {
    rootPid: 1000 + i,
    pids: [1000 + i, 2000 + i],
    listenerPorts: [5173 + i],
    associatedWorkspaceIds: [`ws-${i}`],
    reason: `stale worktree dev server ${i} with a long explanatory reason string`,
  };
}

function fatMonitorState(): MonitorState {
  return {
    timer: null,
    nextRunAt: null,
    lastRun: { at: "2026-08-11T00:00:00.000Z", relaunched: 0, merged: 1, nudged: 0, resources: null, warnings: 0 },
    currentIntervalMin: 4,
    recentActions: [],
    lastResourceSnapshot: {
      at: "2026-08-11T00:00:00.000Z",
      protectedPorts: [3001, 5173],
      processes: Array.from({ length: 40 }, (_, i) => ({ pid: 100 + i, name: "node.exe", commandLine: `node very/long/command/line/${i}` })),
      listeners: Array.from({ length: 40 }, (_, i) => ({ pid: 100 + i, port: 40000 + i })),
      activeWorkspaces: Array.from({ length: 20 }, (_, i) => ({ workspaceId: `ws-${i}`, workingDir: `/tmp/wt-${i}` })),
      kept: Array.from({ length: 25 }, (_, i) => ({ ...decision(i), action: undefined })),
      cleaned: Array.from({ length: 25 }, (_, i) => ({ ...decision(i), action: "cleaned" })),
    } as unknown as MonitorState["lastResourceSnapshot"],
    warnings: [],
    lastHealthCheckAt: null,
    currentCycle: null,
    lastCyclePhaseTimings: {
      at: "2026-08-11T00:00:00.000Z",
      totalMs: 12345,
      phases: Array.from({ length: 15 }, (_, i) => ({ phase: `phase-${i}`, ms: i * 100 })),
    } as unknown as MonitorState["lastCyclePhaseTimings"],
  };
}

function buildStatusRoute(state: MonitorState) {
  const handlers: Record<string, Handler> = {};
  const fakeApp = {
    post: (path: string, h: Handler) => { handlers[path] = h; },
    get: (path: string, h: Handler) => { handlers[path] = h; },
  } as unknown as Hono;
  setupMonitorRoutes(fakeApp, state, async () => {}, async () => {});
  return async (opts: { verbose?: boolean; ifNoneMatch?: string } = {}) => {
    const ctx = {
      json: (v: unknown) => v,
      req: {
        query: (key: string) => (key === "verbose" && opts.verbose ? "1" : undefined),
        header: (key: string) => (key.toLowerCase() === "if-none-match" ? opts.ifNoneMatch : undefined),
      },
    };
    return (await handlers["/api/internal/monitor-status"](ctx)) as Response;
  };
}

beforeEach(() => {
  dbHolder.current = createTestDb().db;
  // The prefs read is cached (#402) — start each test from a cold cache.
  invalidatePreferencesCache();
});

describe("monitor-status payload diet (2026-08-11 G5)", () => {
  it("default payload slims the snapshot to {at, kept, cleaned} (capped) and drops phase timings", async () => {
    const request = buildStatusRoute(fatMonitorState());
    const res = await request();

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty("lastCyclePhaseTimings");
    const snapshot = body.resourceSnapshot as Record<string, unknown>;
    expect(Object.keys(snapshot).sort()).toEqual(["at", "cleaned", "kept"]);
    expect((snapshot.kept as unknown[]).length).toBeLessThanOrEqual(5);
    expect((snapshot.cleaned as unknown[]).length).toBeLessThanOrEqual(5);
    // The fields the client actually renders are intact.
    expect(snapshot.at).toBe("2026-08-11T00:00:00.000Z");
    expect((snapshot.cleaned as Array<{ action: string }>)[0].action).toBe("cleaned");
  });

  it("?verbose=1 serves the full snapshot and the phase timings", async () => {
    const request = buildStatusRoute(fatMonitorState());
    const res = await request({ verbose: true });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("lastCyclePhaseTimings");
    const snapshot = body.resourceSnapshot as Record<string, unknown>;
    expect((snapshot.processes as unknown[]).length).toBe(40);
    expect((snapshot.listeners as unknown[]).length).toBe(40);
    expect((snapshot.kept as unknown[]).length).toBe(25);
  });

  it("the default payload is a fraction of the verbose one", async () => {
    const request = buildStatusRoute(fatMonitorState());
    const slim = JSON.stringify(await (await request()).json());
    const fat = JSON.stringify(await (await request({ verbose: true })).json());
    expect(slim.length).toBeLessThan(fat.length / 2);
  });

  it("answers a conditional GET on unchanged state with a bodyless 304", async () => {
    const request = buildStatusRoute(fatMonitorState());
    const first = await request();
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();

    const second = await request({ ifNoneMatch: etag! });
    expect(second.status).toBe(304);
    expect(second.headers.get("ETag")).toBe(etag);
    expect(await second.text()).toBe("");
  });

  it("a changed status invalidates the ETag (no stale 304)", async () => {
    const state = fatMonitorState();
    const request = buildStatusRoute(state);
    const etag = (await request()).headers.get("ETag")!;

    state.lastRun = { at: "2026-08-11T01:00:00.000Z", relaunched: 2, merged: 0, nudged: 0, resources: null, warnings: 0 };
    const res = await request({ ifNoneMatch: etag });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).not.toBe(etag);
  });
});
