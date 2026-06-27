import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSessionState } from "../services/session-manager/types.js";

vi.useFakeTimers();

// Track batched inserts — must be defined before the mock factory runs.
const insertedBatches: Array<Array<{ sessionId: string; type: string }>> = [];
// Per-session control for simulating a racing-cleanup FK insert failure.
// `null` => the insert resolves and is recorded; otherwise the insert for that
// sessionId rejects with `rejectInsertWith`.
let rejectInsertFor: string | null = null;
let rejectInsertWith: Error = new Error("SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed");

vi.mock("../db/index.js", () => {
  const insert = vi.fn(() => ({
    values: vi.fn((rows: Array<{ sessionId: string; type: string }>) => {
      const sid = rows[0]?.sessionId;
      if (sid && sid === rejectInsertFor) {
        // Simulate the row vanishing under us (workspace cleanup deleted the
        // session) — the FK constraint rejects the batch insert.
        return Promise.reject(rejectInsertWith);
      }
      insertedBatches.push(rows);
      return Promise.resolve();
    }),
  }));
  const mockDb = {
    insert,
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ stats: null }])) })) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
  };
  return { db: mockDb, writeDb: mockDb };
});

// Spy on console.error so we can assert the FK swallow does NOT log, while a
// non-FK failure DOES. Other console noise is silenced.
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "log").mockImplementation(() => {});

// Import after mocks are in place
const { createBroadcaster } = await import("../services/session-manager/broadcast.js");

describe("broadcast DB flush-on-exit + FK race", () => {
  // @covers agent-sessions.persist.split-batch [error-handling, concurrency]
  let state: ReturnType<typeof createSessionState>;
  let broadcast: ReturnType<typeof createBroadcaster>;

  beforeEach(() => {
    insertedBatches.length = 0;
    rejectInsertFor = null;
    rejectInsertWith = new Error("SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed");
    errorSpy.mockClear();
    state = createSessionState();
    broadcast = createBroadcaster(state, undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  // ---- (a) 250ms TIME-based flush of a partial (<50) batch ----
  it("flushes a partial (<50) batch only after the 250ms timer elapses", () => {
    broadcast("time1", { type: "stderr", data: "p1" });
    broadcast("time1", { type: "stderr", data: "p2" });
    broadcast("time1", { type: "stderr", data: "p3" });

    // 3 buffered rows: well under the 50-row size flush — a timer is armed, nothing written yet.
    expect(insertedBatches).toHaveLength(0);
    expect(state.dbWriteTimers.has("time1")).toBe(true);

    // Just shy of the interval — still not flushed (asserts it is genuinely TIME-gated).
    vi.advanceTimersByTime(249);
    expect(insertedBatches).toHaveLength(0);

    // Crossing 250ms fires the timer and flushes the whole partial batch.
    vi.advanceTimersByTime(1);
    expect(insertedBatches).toHaveLength(1);
    expect(insertedBatches[0]).toHaveLength(3);
    expect(insertedBatches[0].map((r) => r.type)).toEqual(["stderr", "stderr", "stderr"]);
    // Timer is consumed, not left dangling.
    expect(state.dbWriteTimers.has("time1")).toBe(false);
  });

  // ---- (b) flush-on-EXIT guarantee: the buffered tail is not lost ----
  it("flushes the pre-timer buffered tail together with exit — no lost or duplicated tail", () => {
    broadcast("exit1", { type: "stderr", data: "tail-1" });
    broadcast("exit1", { type: "stderr", data: "tail-2" });

    // Timer pending, nothing flushed — these would be lost if exit didn't flush.
    expect(insertedBatches).toHaveLength(0);
    expect(state.dbWriteTimers.has("exit1")).toBe(true);

    broadcast("exit1", { type: "exit", exitCode: 0 });

    // Exit flushes the entire buffer in ONE batch: both tail stderrs + the exit row.
    expect(insertedBatches).toHaveLength(1);
    expect(insertedBatches[0].map((r) => r.type)).toEqual(["stderr", "stderr", "exit"]);

    // Timer cleared so the now-empty buffer can't double-fire.
    expect(state.dbWriteTimers.has("exit1")).toBe(false);
    vi.advanceTimersByTime(500);
    expect(insertedBatches).toHaveLength(1); // no second (duplicate / lost-then-late) batch
  });

  // ---- (c) FK-constraint insert race is swallowed (concurrency: simulated) ----
  it("swallows an FK-constraint batch-insert failure (racing cleanup) — no throw, no error log, session finalizes", async () => {
    // NOTE: this is a SIMULATED concurrency race (the FK rejection a deleted
    // session would cause), not true parallel execution.
    rejectInsertFor = "fk1";
    broadcast("fk1", { type: "stderr", data: "late-message" });

    // Exit triggers the flush → insertSessionMessages rejects with the FK error.
    // The broadcast call itself must not throw.
    expect(() => broadcast("fk1", { type: "exit", exitCode: 0 })).not.toThrow();

    // Let the rejected insert's swallowing `.catch` run.
    await Promise.resolve();
    await Promise.resolve();

    // FK violation is swallowed: not surfaced as an error log.
    expect(errorSpy).not.toHaveBeenCalled();
    // Session still finalized cleanly: exit cleared the write timer.
    expect(state.dbWriteTimers.has("fk1")).toBe(false);
  });

  // ---- (c') the swallow is FK-SPECIFIC, not a blanket suppression ----
  it("surfaces a NON-FK batch-insert failure via console.error (swallow is FK-specific)", async () => {
    rejectInsertFor = "busy1";
    rejectInsertWith = new Error("SQLITE_BUSY: database is locked");

    broadcast("busy1", { type: "exit", exitCode: 0 });

    await Promise.resolve();
    await Promise.resolve();

    // A non-FK failure is NOT swallowed — it is logged.
    expect(errorSpy).toHaveBeenCalled();
  });
});
