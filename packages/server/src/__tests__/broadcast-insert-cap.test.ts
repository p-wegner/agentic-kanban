import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSessionState } from "../services/session-manager/types.js";

// Track batched inserts — must be defined before the mock factory runs
const insertedBatches: Array<Array<{ sessionId: string; type: string }>> = [];

vi.mock("../db/index.js", () => {
  const insert = vi.fn(() => ({
    values: vi.fn((rows: Array<{ sessionId: string; type: string }>) => {
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

const capMock = vi.fn(() => Promise.resolve(0));
vi.mock("../services/session-message-pruner.service.js", () => ({
  capSessionMessagesForSession: capMock,
}));

// Silence noise from broadcast internals
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "log").mockImplementation(() => {});

// Import after mocks are in place
const { createBroadcaster } = await import("../services/session-manager/broadcast.js");

/** Let the fire-and-forget insert → cap promise chains settle. */
async function settleMicrotasks() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

describe("broadcast insert-time session_messages cap (#404)", () => {
  let state: ReturnType<typeof createSessionState>;
  let broadcast: ReturnType<typeof createBroadcaster>;

  beforeEach(() => {
    insertedBatches.length = 0;
    capMock.mockClear();
    state = createSessionState();
    broadcast = createBroadcaster(state, undefined);
  });

  function emitFlushes(sessionId: string, flushes: number) {
    // 50 non-stdout messages = one immediate batch-size flush
    for (let i = 0; i < flushes * 50; i++) {
      broadcast(sessionId, { type: "stderr", sessionId, data: `line ${i}` });
    }
  }

  it("does not trim before the Nth flush", async () => {
    emitFlushes("cap-s1", 7);
    await settleMicrotasks();
    expect(insertedBatches).toHaveLength(7);
    expect(capMock).not.toHaveBeenCalled();
  });

  it("trims on every 8th flush for the flushed session", async () => {
    emitFlushes("cap-s2", 8);
    await settleMicrotasks();
    expect(capMock).toHaveBeenCalledTimes(1);
    expect(capMock).toHaveBeenCalledWith("cap-s2", expect.anything());

    emitFlushes("cap-s2", 8);
    await settleMicrotasks();
    expect(capMock).toHaveBeenCalledTimes(2);
  });

  it("counts flushes per session, not globally", async () => {
    emitFlushes("cap-s3", 4);
    emitFlushes("cap-s4", 4);
    await settleMicrotasks();
    // 8 flushes total, but neither session reached 8 on its own
    expect(capMock).not.toHaveBeenCalled();
  });

  it("resets the flush counter on session exit", async () => {
    emitFlushes("cap-s5", 3);
    broadcast("cap-s5", { type: "exit", sessionId: "cap-s5", exitCode: 0 }); // exit row = 4th flush, then the counter is cleared
    await settleMicrotasks();
    expect(capMock).not.toHaveBeenCalled();
    // A later session reusing the id starts from 0: it fires on ITS 8th flush.
    // Without the reset the stale count (4) would put the next multiple of 8
    // four flushes later, so this emission would not fire at all.
    emitFlushes("cap-s5", 8);
    await settleMicrotasks();
    expect(capMock).toHaveBeenCalledTimes(1);
  });
});
