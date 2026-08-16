import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSessionState } from "../services/session-manager/types.js";

// The lifecycle's exit path is heavy to stand up; what this pins is the ORDERING HAZARD
// that made the ExitPlanMode auto-resume dead code (#580), which is a property of
// broadcast alone.

vi.mock("../db/index.js", () => {
  const mockDb = {
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ stats: null }])) })) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
  };
  return { db: mockDb, writeDb: mockDb };
});
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "log").mockImplementation(() => {});

const { createBroadcaster } = await import("../services/session-manager/broadcast.js");

const SID = "sess-580";

describe("ExitPlanMode-denied flag ordering (#580)", () => {
  let state: ReturnType<typeof createSessionState>;
  let broadcast: ReturnType<typeof createBroadcaster>;

  beforeEach(() => {
    state = createSessionState();
    broadcast = createBroadcaster(state, undefined);
  });

  it("broadcast() CLEARS the flag on exit — so any consumer must read it first", () => {
    state.sessionExitPlanModeDenied.add(SID);

    // Read before: what the fixed call site does.
    const capturedBefore = state.sessionExitPlanModeDenied.has(SID);
    broadcast(SID, { type: "exit", exitCode: 0 } as never);
    // Read after: what the exit handler used to do — always false, which is why the
    // auto-resume branch never ran from the day it was written.
    const readAfter = state.sessionExitPlanModeDenied.has(SID);

    expect(capturedBefore).toBe(true);
    expect(readAfter).toBe(false);
  });

  it("a non-exit broadcast leaves the flag alone", () => {
    state.sessionExitPlanModeDenied.add(SID);
    broadcast(SID, { type: "stdout", data: "still working" } as never);
    expect(state.sessionExitPlanModeDenied.has(SID)).toBe(true);
  });

  it("the flag is absent for a session that never denied ExitPlanMode", () => {
    broadcast(SID, { type: "exit", exitCode: 0 } as never);
    expect(state.sessionExitPlanModeDenied.has(SID)).toBe(false);
  });
});
