/**
 * perf(G4) — the session_activity broadcast (options.onActivity from tool
 * activity) is throttled to one emit per 500ms window per session: leading
 * edge fires immediately, later calls collapse into ONE trailing emit carrying
 * the newest activity. The exit path bypasses the throttle: its clearing
 * broadcast ("") is immediate and any pending trailing emit is dropped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSessionState, type SessionState, type SessionManagerOptions } from "../services/session-manager/types.js";
import type { ParsedStreamEvent } from "../services/agent-provider.js";

vi.mock("../db/index.js", () => {
  const mockDb = {
    insert: vi.fn(() => ({ values: vi.fn(() => ({ catch: vi.fn() })) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ stats: null }])) })) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
  };
  return { db: mockDb, writeDb: mockDb };
});
vi.mock("../services/agent.service.js", () => ({ isStdinOpen: vi.fn(() => true) }));
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "log").mockImplementation(() => {});

const { applyStreamEvent, createBroadcaster, ACTIVITY_BROADCAST_THROTTLE_MS } = await import(
  "../services/session-manager/broadcast.js"
);

const SID = "sess-throttle";

function setup() {
  const state: SessionState = createSessionState();
  state.sessionContexts.set(SID, { workspaceId: "w1", issueId: "i1", projectId: "p1" });
  const activity: Array<[string, string, string, string]> = [];
  const options: SessionManagerOptions = {
    onActivity: (...args) => activity.push(args as [string, string, string, string]),
  };
  return { state, options, activity };
}

function toolEvent(command: string): ParsedStreamEvent {
  return { toolActivity: { name: "Bash", input: { command } } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("session_activity throttle", () => {
  it("emits the first activity immediately (leading edge)", () => {
    const { state, options, activity } = setup();
    applyStreamEvent(state, options, SID, toolEvent("ls"));
    expect(activity).toHaveLength(1);
  });

  it("collapses a burst within the window into one leading + one trailing emit with the newest activity", () => {
    const { state, options, activity } = setup();
    applyStreamEvent(state, options, SID, toolEvent("first"));
    applyStreamEvent(state, options, SID, toolEvent("second"));
    applyStreamEvent(state, options, SID, toolEvent("third"));
    // Only the leading emit so far.
    expect(activity).toHaveLength(1);
    expect(activity[0][3]).toContain("first");

    vi.advanceTimersByTime(ACTIVITY_BROADCAST_THROTTLE_MS);
    // One trailing emit, carrying the NEWEST activity — not one per event.
    expect(activity).toHaveLength(2);
    expect(activity[1][3]).toContain("third");

    // Nothing further without new events.
    vi.advanceTimersByTime(5 * ACTIVITY_BROADCAST_THROTTLE_MS);
    expect(activity).toHaveLength(2);
  });

  it("emits again immediately once the window has passed", () => {
    const { state, options, activity } = setup();
    applyStreamEvent(state, options, SID, toolEvent("a"));
    vi.advanceTimersByTime(ACTIVITY_BROADCAST_THROTTLE_MS + 1);
    applyStreamEvent(state, options, SID, toolEvent("b"));
    expect(activity).toHaveLength(2);
    expect(activity[1][3]).toContain("b");
  });

  it("throttles per session — a second session's leading emit is not delayed", () => {
    const { state, options, activity } = setup();
    const SID2 = "sess-throttle-2";
    state.sessionContexts.set(SID2, { workspaceId: "w2", issueId: "i2", projectId: "p1" });
    applyStreamEvent(state, options, SID, toolEvent("one"));
    applyStreamEvent(state, options, SID2, toolEvent("two"));
    expect(activity).toHaveLength(2);
    expect(activity[0][2]).toBe(SID);
    expect(activity[1][2]).toBe(SID2);
  });

  it("exit bypasses the throttle: clearing broadcast is immediate and the pending trailing emit is dropped", () => {
    const { state, options, activity } = setup();
    const broadcast = createBroadcaster(state, options);

    applyStreamEvent(state, options, SID, toolEvent("lead"));
    applyStreamEvent(state, options, SID, toolEvent("stale-pending"));
    expect(activity).toHaveLength(1);

    broadcast(SID, { type: "exit", sessionId: SID, exitCode: 0 });
    // The clearing "" broadcast fired immediately despite the open window.
    expect(activity).toHaveLength(2);
    expect(activity[1][3]).toBe("");

    // The stale pending trailing emit must NOT resurrect activity after exit.
    vi.advanceTimersByTime(5 * ACTIVITY_BROADCAST_THROTTLE_MS);
    expect(activity).toHaveLength(2);
  });
});
