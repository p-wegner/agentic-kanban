import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSessionState, type SessionState, type SessionManagerOptions } from "../services/session-manager/types.js";
import type { ParsedStreamEvent } from "../services/agent-provider.js";

// Mock the DB so the fire-and-forget persistence paths (stats, providerSessionId)
// don't touch a real database — this test characterizes the synchronous state
// mutations and option callbacks, not persistence (covered by broadcast-batch).
const updateSetCalls: Record<string, unknown>[] = [];
vi.mock("../db/index.js", () => {
  const mockDb = {
    insert: vi.fn(() => ({ values: vi.fn(() => ({ catch: vi.fn() })) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ stats: null }])) })) })) })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateSetCalls.push(values);
        return { where: vi.fn(() => Promise.resolve()) };
      }),
    })),
  };
  return { db: mockDb, writeDb: mockDb };
});

// isStdinOpen controls the turn-completion branch.
vi.mock("../services/agent.service.js", () => ({ isStdinOpen: vi.fn(() => true) }));

vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "log").mockImplementation(() => {});

const { applyStreamEvent } = await import("../services/session-manager/broadcast.js");

const SID = "sess-1";

type Calls = {
  liveStats: unknown[][];
  activity: unknown[][];
  todos: unknown[][];
};

function setup(): { state: SessionState; options: SessionManagerOptions; calls: Calls } {
  const state = createSessionState();
  state.sessionContexts.set(SID, { workspaceId: "w1", issueId: "i1", projectId: "p1" });
  const calls: Calls = { liveStats: [], activity: [], todos: [] };
  const options: SessionManagerOptions = {
    onLiveStats: (...args) => calls.liveStats.push(args),
    onActivity: (...args) => calls.activity.push(args),
    onTodos: (...args) => calls.todos.push(args),
  };
  return { state, options, calls };
}

function apply(state: SessionState, options: SessionManagerOptions, evt: ParsedStreamEvent) {
  applyStreamEvent(state, options, SID, evt);
}

describe("applyStreamEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateSetCalls.length = 0;
  });

  it("flags substantive output for content-bearing events but not empty ones", () => {
    const { state, options } = setup();
    apply(state, options, {});
    expect(state.sessionSubstantiveOutput.has(SID)).toBe(false);
    apply(state, options, { assistantText: "hi" });
    expect(state.sessionSubstantiveOutput.has(SID)).toBe(true);
  });

  it("accumulates assistant text", () => {
    const { state, options } = setup();
    apply(state, options, { assistantText: "first" });
    apply(state, options, { assistantText: "second" });
    expect(state.sessionTextParts.get(SID)).toEqual(["first", "second"]);
  });

  it("tracks ExitPlanMode denial and turn completion", () => {
    const { state, options } = setup();
    apply(state, options, { exitPlanModeDenied: true });
    expect(state.sessionExitPlanModeDenied.has(SID)).toBe(true);
    apply(state, options, { turnComplete: true });
    expect(state.turnStates.get(SID)).toBe("waiting");
  });

  it("applies live stats and emits onLiveStats", () => {
    const { state, options, calls } = setup();
    apply(state, options, { liveStats: { model: "opus", contextTokens: 1234, toolUses: 3, subagentDelta: 1 } });
    expect(state.sessionModels.get(SID)).toBe("opus");
    expect(state.sessionContextTokens.get(SID)).toBe(1234);
    expect(state.sessionToolUses.get(SID)).toBe(3);
    expect(state.sessionSubagents.get(SID)).toBe(1);
    expect(calls.liveStats).toHaveLength(1);
    expect(calls.liveStats[0]).toEqual(["p1", "i1", "opus", 1234, 3, 1]);
  });

  it("records tool activity and emits onActivity, tracking Agent tool_use ids", () => {
    const { state, options, calls } = setup();
    apply(state, options, { toolActivity: { name: "Bash", input: { command: "ls" } } });
    expect(state.sessionLastTool.get(SID)).toBe("Bash");
    expect(calls.activity.length).toBeGreaterThanOrEqual(1);

    apply(state, options, { toolActivity: { name: "Agent", input: {}, toolUseId: "t-9" } });
    expect(state.sessionAgentToolUseIds.get(SID)?.has("t-9")).toBe(true);
  });

  it("handles TodoWrite and suppresses Task tracking once TodoWrite is seen", () => {
    const { state, options, calls } = setup();
    apply(state, options, { toolActivity: { name: "TodoWrite", input: {} }, todos: [{ subject: "do x", status: "pending" }] });
    expect(state.sessionHasTodoWrite.has(SID)).toBe(true);
    const todoCalls = calls.todos.length;
    // TaskCreate must be ignored now that TodoWrite has taken precedence.
    apply(state, options, { toolActivity: { name: "TaskCreate", input: { subject: "ignored" } } });
    expect(state.sessionTasks.has(SID)).toBe(false);
    expect(calls.todos.length).toBe(todoCalls);
  });

  it("tracks TaskCreate then TaskUpdate when no TodoWrite is present", () => {
    const { state, options } = setup();
    apply(state, options, { toolActivity: { name: "TaskCreate", input: { subject: "build" } } });
    const tasks = state.sessionTasks.get(SID);
    expect(tasks?.get("1")).toEqual({ subject: "build", status: "pending" });
    apply(state, options, { toolActivity: { name: "TaskUpdate", input: { taskId: "1", status: "completed" } } });
    expect(state.sessionTasks.get(SID)?.get("1")?.status).toBe("completed");
  });

  it("decrements the subagent count and accumulates result text on a tracked tool_result", () => {
    const { state, options, calls } = setup();
    apply(state, options, { liveStats: { model: "opus", contextTokens: 10, subagentDelta: 1 } });
    apply(state, options, { toolActivity: { name: "Agent", input: {}, toolUseId: "a-1" } });
    expect(state.sessionSubagents.get(SID)).toBe(1);

    calls.liveStats.length = 0;
    apply(state, options, { toolResult: { toolUseId: "a-1", agentResultText: "done" } });
    expect(state.sessionSubagents.get(SID)).toBe(0);
    expect(state.sessionAgentToolUseIds.get(SID)?.has("a-1")).toBe(false);
    expect(state.sessionTextParts.get(SID)).toContain("done");
    expect(calls.liveStats).toHaveLength(1); // re-broadcast with decremented count
  });

  it("ignores tool_result for an untracked tool_use id", () => {
    const { state, options } = setup();
    apply(state, options, { toolResult: { toolUseId: "unknown" } });
    expect(state.sessionSubagents.has(SID)).toBe(false);
  });

  // #930: a healthy running session used to persist contextTokens/lastTool only on the
  // TERMINAL stats event, so the API read back null/null and a stale launch-time
  // lastSessionAt for the entire lifetime of a still-running session — indistinguishable
  // from a launch-failed/dead one. These drive a fake live stream through applyStreamEvent
  // and assert the persisted `stats` blob (what the read-side projection consumes) advances.
  describe("live activity persistence (#930)", () => {
    it("persists lastTool to the stats blob as soon as a tool_use event arrives, not just at session end", async () => {
      const { state, options } = setup();
      apply(state, options, { toolActivity: { name: "Bash", input: { command: "git status" } } });
      // persistLiveActivity's DB round-trip is async (mergeExistingStats then update); flush it.
      await vi.waitFor(() => expect(updateSetCalls.length).toBeGreaterThan(0));

      const persisted = updateSetCalls.find((c) => typeof c.stats === "string");
      expect(persisted).toBeDefined();
      const blob = JSON.parse(persisted!.stats as string);
      expect(blob.lastTool).toBe("Bash");
      expect(typeof blob.lastActivityAt).toBe("string");
    });

    it("persists contextTokens to the stats blob as liveStats events arrive", async () => {
      const { state, options } = setup();
      apply(state, options, { liveStats: { model: "opus", contextTokens: 4200 } });
      await vi.waitFor(() => expect(updateSetCalls.length).toBeGreaterThan(0));

      const persisted = updateSetCalls.find((c) => typeof c.stats === "string");
      expect(persisted).toBeDefined();
      const blob = JSON.parse(persisted!.stats as string);
      expect(blob.contextTokens).toBe(4200);
      expect(typeof blob.lastActivityAt).toBe("string");
    });

    it("VERIFY-IT-BITES: removing the live-persist call means no stats write happens before session end", async () => {
      // Regression guard against re-introducing the #930 bug: a toolActivity/liveStats
      // event with NO terminal `stats` event must still reach updateSessionStats. If the
      // live-persist wiring in applyLiveStats/applyToolActivity were removed, this would
      // fail because updateSetCalls would stay empty (the terminal stats path is the only
      // other writer, and no `stats` event is emitted in this test).
      const { state, options } = setup();
      apply(state, options, { toolActivity: { name: "Read", input: { file_path: "a.ts" } } });
      apply(state, options, { liveStats: { model: "opus", contextTokens: 999 } });

      await vi.waitFor(() => expect(updateSetCalls.length).toBeGreaterThan(0));
    });
  });
});
