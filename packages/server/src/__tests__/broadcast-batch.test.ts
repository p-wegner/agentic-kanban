import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSessionState } from "../services/session-manager/types.js";

vi.useFakeTimers();

// Track batched inserts — must be defined before the mock factory runs
const insertedBatches: Array<Array<{ sessionId: string; type: string }>> = [];

vi.mock("../db/index.js", () => {
  const insert = vi.fn(() => ({
    values: vi.fn((rows: Array<{ sessionId: string; type: string }>) => {
      insertedBatches.push(rows);
      return { catch: vi.fn() };
    }),
  }));
  const mockDb = {
    insert,
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ stats: null }])) })) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
  };
  return { db: mockDb, writeDb: mockDb };
});

// Silence noise from broadcast internals
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "log").mockImplementation(() => {});

// Import after mocks are in place
const { createBroadcaster } = await import("../services/session-manager/broadcast.js");

describe("broadcast DB batching", () => {
  let state: ReturnType<typeof createSessionState>;
  let broadcast: ReturnType<typeof createBroadcaster>;

  beforeEach(() => {
    insertedBatches.length = 0;
    state = createSessionState();
    broadcast = createBroadcaster(state, undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it("does not write stdout messages to DB", () => {
    broadcast("s1", { type: "stdout", data: "hello" });
    vi.advanceTimersByTime(500);
    // stdout is served from the .out file — no DB inserts
    expect(insertedBatches).toHaveLength(0);
  });

  it("does not schedule a DB timer for stdout-only messages", () => {
    broadcast("s1", { type: "stdout", data: "a" });
    broadcast("s1", { type: "stdout", data: "b" });
    expect(state.dbWriteTimers.has("s1")).toBe(false);
    vi.advanceTimersByTime(500);
    expect(insertedBatches).toHaveLength(0);
  });

  it("writes exit messages to DB immediately on exit flush", () => {
    broadcast("s3", { type: "stdout", data: "x" });
    expect(insertedBatches).toHaveLength(0);

    broadcast("s3", { type: "exit", exitCode: 0 });

    expect(insertedBatches).toHaveLength(1);
    expect(insertedBatches[0]).toHaveLength(1);
    expect(insertedBatches[0].map((r) => r.type)).toEqual(["exit"]);
  });

  it("writes stderr messages to DB via batched flush", () => {
    broadcast("s6", { type: "stderr", data: "err" });
    expect(insertedBatches).toHaveLength(0);

    vi.advanceTimersByTime(250);

    expect(insertedBatches).toHaveLength(1);
    expect(insertedBatches[0]).toHaveLength(1);
    expect(insertedBatches[0].map((r) => r.type)).toEqual(["stderr"]);
  });

  it("flushes immediately when batch size (50) of non-stdout is reached", () => {
    for (let i = 0; i < 50; i++) {
      broadcast("s2", { type: "stderr", data: `err${i}` });
    }
    expect(insertedBatches).toHaveLength(1);
    expect(insertedBatches[0]).toHaveLength(50);
  });

  it("clears the timer on exit so it does not fire again", () => {
    broadcast("s5", { type: "stderr", data: "y" });
    expect(state.dbWriteTimers.has("s5")).toBe(true);

    broadcast("s5", { type: "exit", exitCode: 0 });

    expect(state.dbWriteTimers.has("s5")).toBe(false);
    const callsBefore = insertedBatches.length;
    vi.advanceTimersByTime(500);
    expect(insertedBatches.length).toBe(callsBefore);
  });
});
