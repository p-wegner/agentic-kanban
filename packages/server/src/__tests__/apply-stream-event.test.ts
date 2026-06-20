import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSessionState, type SessionState, type SessionManagerOptions } from "../services/session-manager/types.js";
import type { ParsedStreamEvent } from "../services/agent-provider.js";

// Mock the DB so the fire-and-forget persistence paths (stats, providerSessionId)
// don't touch a real database — this test characterizes the synchronous state
// mutations and option callbacks, not persistence (covered by broadcast-batch).
vi.mock("../db/index.js", () => {
  const mockDb = {
    insert: vi.fn(() => ({ values: vi.fn(() => ({ catch: vi.fn() })) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ stats: null }])) })) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
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
  beforeEach(() => vi.clearAllMocks());

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
});
