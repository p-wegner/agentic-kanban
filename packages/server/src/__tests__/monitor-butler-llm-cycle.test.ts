// @covers monitor-orchestration.butler.llm-cycle [workflow, observability, config]
//
// The Monitor Butler (Steward) is the LLM-driven, off-by-default board-health agent.
// It is hard to exercise end-to-end (it spawns a real Claude Agent SDK session and
// acts through MCP tools), so this is a thin unit test of the three load-bearing
// invariants that don't need a live model:
//
//   1. workflow      — single-active-project resolution: a cycle with no explicit
//                      projectId acts on the ONE project named by the activeProjectId
//                      preference, and skips entirely when there is none.
//   2. observability — a crashed cycle (SDK session throws) is ISOLATED: the throw is
//                      caught, logged loudly to console.error, and recorded as an
//                      "error" board-health audit event — it never propagates.
//   3. config        — the `monitor_butler_enabled` gate controls whether scheduled
//                      cycles run at all.
//
// Mutation check: delete the try/catch in runMonitorButlerCycle → the thrown SDK error
// propagates → the awaited cycle promise rejects → the isolation test goes RED.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface HealthEvent {
  projectId: string;
  cycleId: string;
  eventType: string;
  summary: string;
  details?: unknown;
}

const h = vi.hoisted(() => ({
  prefs: new Map<string, string>(),
  projects: new Map<string, { id: string; name: string; repoPath: string }>(),
  healthEvents: [] as HealthEvent[],
  board: { totals: { totalIssues: 0, activeWorkspaces: 0 } } as {
    totals: { totalIssues: number; activeWorkspaces: number };
  },
  sdk: { mode: "result" as "result" | "throw", error: null as Error | null },
}));

vi.mock("../repositories/preferences.repository.js", () => ({
  getPreference: vi.fn(async (key: string) => h.prefs.get(key) ?? null),
  setPreference: vi.fn(async () => {}),
}));

vi.mock("../repositories/monitor-butler.repository.js", () => ({
  getProjectSummaryById: vi.fn(async (id: string) => {
    const p = h.projects.get(id);
    return p ? [p] : [];
  }),
}));

vi.mock("../repositories/board-health-events.repository.js", () => ({
  logBoardHealthEvent: vi.fn(async (e: HealthEvent) => {
    h.healthEvents.push(e);
  }),
}));

vi.mock("../services/board-status.js", () => ({
  getBoardStatus: vi.fn(async () => h.board),
}));

vi.mock("../services/agent-provider/helpers.js", () => ({
  buildSpawnEnv: vi.fn(() => ({})),
  getMcpServersConfig: vi.fn(() => ({})),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    if (h.sdk.mode === "throw") {
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next(): Promise<IteratorResult<Record<string, unknown>>> {
          throw h.sdk.error ?? new Error("sdk boom");
        },
      };
    }
    let yielded = false;
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<Record<string, unknown>>> {
        if (yielded) return { done: true, value: undefined as unknown as Record<string, unknown> };
        yielded = true;
        return {
          done: false,
          value: { type: "result", subtype: "success", result: "cycle complete" },
        };
      },
    };
  }),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { getProjectSummaryById } from "../repositories/monitor-butler.repository.js";
import {
  runMonitorButlerCycle,
  startMonitorButler,
  stopMonitorButler,
} from "../services/monitor-butler.js";

const ACTIVE_PROJECT = "active-proj-1";

beforeEach(() => {
  h.prefs = new Map<string, string>();
  h.projects = new Map();
  h.healthEvents = [];
  h.board = { totals: { totalIssues: 3, activeWorkspaces: 1 } };
  h.sdk = { mode: "result", error: null };

  // Default: a single active project resolvable from the preference.
  h.prefs.set("activeProjectId", ACTIVE_PROJECT);
  h.projects.set(ACTIVE_PROJECT, { id: ACTIVE_PROJECT, name: "Proj", repoPath: process.cwd() });

  vi.mocked(query).mockClear();
  vi.mocked(getProjectSummaryById).mockClear();
});

afterEach(() => {
  // Always tear down the scheduler so the syncTimer/generation never leak between tests.
  stopMonitorButler();
  vi.useRealTimers();
});

describe("monitor-butler LLM cycle", () => {
  it("resolves and acts on the SINGLE active project from the activeProjectId preference", async () => {
    await runMonitorButlerCycle(); // no explicit projectId

    // Resolution: it looked up exactly the one active project.
    expect(getProjectSummaryById).toHaveBeenCalledTimes(1);
    expect(getProjectSummaryById).toHaveBeenCalledWith(ACTIVE_PROJECT);

    // It spawned exactly one SDK session (acted on the one project).
    expect(query).toHaveBeenCalledTimes(1);

    // Every audit event is scoped to that one project, and the cycle bookends are logged.
    expect(h.healthEvents.length).toBeGreaterThan(0);
    expect(h.healthEvents.every((e) => e.projectId === ACTIVE_PROJECT)).toBe(true);
    expect(h.healthEvents.some((e) => e.eventType === "cycle_start")).toBe(true);
    expect(h.healthEvents.some((e) => e.eventType === "cycle_end")).toBe(true);
  });

  it("skips the cycle when there is no active project to resolve", async () => {
    h.prefs.delete("activeProjectId");

    await expect(runMonitorButlerCycle()).resolves.toBeUndefined();

    // No project resolution, no SDK session, no audit noise.
    expect(getProjectSummaryById).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(h.healthEvents).toHaveLength(0);
  });

  it("ISOLATES a thrown SDK error: caught, logged loudly, never propagated", async () => {
    h.sdk = { mode: "throw", error: new Error("SDK session exploded") };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // The crash must be contained — the cycle resolves rather than rejecting.
    await expect(runMonitorButlerCycle({ projectId: ACTIVE_PROJECT })).resolves.toBeUndefined();

    // Observability: a loud console.error AND an "error" board-health audit event.
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[monitor-butler] cycle error"));
    expect(
      h.healthEvents.some(
        (e) => e.eventType === "error" && /SDK session exploded/.test(e.summary),
      ),
    ).toBe(true);

    errSpy.mockRestore();
  });

  it("config gate: monitor_butler_enabled controls whether scheduled cycles run", async () => {
    vi.useFakeTimers();

    // Disabled — the scheduler must NOT run any cycle.
    h.prefs.set("monitor_butler_enabled", "false");
    startMonitorButler();
    await vi.advanceTimersByTimeAsync(6_000); // past the 5s first-cycle delay
    expect(query).not.toHaveBeenCalled();
    stopMonitorButler();

    // Enabled — the first scheduled cycle fires and spawns a session.
    h.prefs.set("monitor_butler_enabled", "true");
    h.prefs.set("monitor_butler_interval_min", "1");
    startMonitorButler();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(query).toHaveBeenCalledTimes(1);
    stopMonitorButler();
  });
});
