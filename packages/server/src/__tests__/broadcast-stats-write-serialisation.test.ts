/**
 * #1001 + #1002 — the session `stats` blob keeps BOTH writers' fields, and `contextTokens`
 * means occupancy rather than a session total.
 *
 * Before this, one claude `result` event drove two independent read-modify-write paths onto
 * the same row: `applyStatsEvent` (durationMs/inputTokens/outputTokens/model/success) and
 * `persistLiveActivity` (contextTokens/lastTool/lastActivityAt). Both read the pre-write row
 * and the second write landed last, so the aggregates were dropped. Measured on the live
 * board before the fix: 102 of the 103 sessions carrying a live-activity `contextTokens` had
 * lost `inputTokens`, `model` and `success`.
 *
 * The `select` here resolves on a later microtask than the `update` deliberately — that is the
 * interleaving the old code lost, and a mock that resolved both immediately would pass either
 * way.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSessionState } from "../services/session-manager/types.js";

/** One in-memory `stats` cell, standing in for the row. */
let storedStats: string | null = null;
/** Every value ever written, so a lost update is visible as a shorter blob following a longer one. */
const writes: string[] = [];

vi.mock("../repositories/broadcast.repository.js", () => ({
  selectSessionStats: vi.fn(async () => {
    // Two awaits: enough for a concurrent writer to interleave between our read and our write.
    await Promise.resolve();
    await Promise.resolve();
    return [{ stats: storedStats }];
  }),
  updateSessionStats: vi.fn(async (_sessionId: string, stats: string) => {
    storedStats = stats;
    writes.push(stats);
  }),
  insertSessionMessages: vi.fn(async () => {}),
  updateProviderSessionId: vi.fn(async () => {}),
}));

vi.mock("../db/index.js", () => {
  const mockDb = {
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
  };
  return { db: mockDb, writeDb: mockDb };
});

vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const { createBroadcaster, ACTIVITY_BROADCAST_THROTTLE_MS } = await import("../services/session-manager/broadcast.js");

vi.useFakeTimers();

const SESSION = "session-1001";

/** The occupancy of ONE request — what the Context Window view is asking about. */
const ASSISTANT_EVENT = JSON.stringify({
  type: "assistant",
  message: {
    model: "claude-opus-4-8",
    usage: { input_tokens: 4_687, cache_read_input_tokens: 120_000 },
    content: [{ type: "text", text: "done" }],
  },
});

/** The session TOTAL — 16x the largest single request, which is why it must not be occupancy. */
const RESULT_EVENT = JSON.stringify({
  type: "result",
  subtype: "success",
  duration_ms: 308_015,
  num_turns: 20,
  total_cost_usd: 4.21,
  usage: { input_tokens: 16_340, cache_read_input_tokens: 2_000_000, output_tokens: 31_402 },
  modelUsage: { "claude-opus-4-8": { inputTokens: 16_340, outputTokens: 31_402 } },
  result: "finished",
});

/**
 * Drain the fire-and-forget write chain, including the activity throttle's trailing emit —
 * `persistLiveActivity` shares one throttle window with the assistant-text heartbeat, so the
 * contextTokens write is the WINDOW's trailing fire, not an immediate one.
 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(ACTIVITY_BROADCAST_THROTTLE_MS + 50);
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function parseStored(): Record<string, unknown> {
  expect(storedStats).not.toBeNull();
  return JSON.parse(storedStats as string) as Record<string, unknown>;
}

describe("#1002: concurrent writers to sessions.stats never lose each other's fields", () => {
  let state: ReturnType<typeof createSessionState>;
  let broadcast: ReturnType<typeof createBroadcaster>;

  beforeEach(() => {
    storedStats = null;
    writes.length = 0;
    state = createSessionState();
    state.sessionProviders.set(SESSION, "claude");
    broadcast = createBroadcaster(state, undefined);
  });

  it("keeps the result event's aggregates alongside the live-activity fields", async () => {
    broadcast(SESSION, { sessionId: SESSION, type: "stdout", data: ASSISTANT_EVENT });
    broadcast(SESSION, { sessionId: SESSION, type: "stdout", data: RESULT_EVENT });
    await settle();

    const stats = parseStored();
    // The result event's half — the fields that were being dropped.
    expect(stats.inputTokens).toBe(16_340);
    expect(stats.outputTokens).toBe(31_402);
    expect(stats.durationMs).toBe(308_015);
    expect(stats.model).toBe("claude-opus-4-8");
    expect(stats.success).toBe(true);
    // The live-activity half, from the same run.
    expect(stats.contextTokens).toBe(124_687);
    expect(typeof stats.lastActivityAt).toBe("string");
  });

  it("#1001: contextTokens is the last request's occupancy, not the session total", async () => {
    broadcast(SESSION, { sessionId: SESSION, type: "stdout", data: ASSISTANT_EVENT });
    broadcast(SESSION, { sessionId: SESSION, type: "stdout", data: RESULT_EVENT });
    await settle();

    const stats = parseStored();
    // 2,016,340 is what the result event's cumulative usage would have produced — the value
    // that rendered as "2.0M / 200.0K" in the UI for a session whose biggest request was 124k.
    expect(stats.contextTokens).not.toBe(2_016_340);
    expect(stats.contextTokens).toBe(124_687);
  });

  it("no write ever drops a key an earlier write had added", async () => {
    broadcast(SESSION, { sessionId: SESSION, type: "stdout", data: ASSISTANT_EVENT });
    broadcast(SESSION, { sessionId: SESSION, type: "stdout", data: RESULT_EVENT });
    await settle();

    // The invariant, stated over the whole write history rather than only the final value:
    // the key set may grow, never shrink. A lost update shows up here even if a later write
    // happens to restore the field.
    let seen = new Set<string>();
    for (const raw of writes) {
      const keys = new Set(Object.keys(JSON.parse(raw) as Record<string, unknown>));
      const dropped = [...seen].filter((k) => !keys.has(k));
      expect(dropped, `write dropped ${dropped.join(", ")}`).toEqual([]);
      seen = new Set([...seen, ...keys]);
    }
    expect(writes.length).toBeGreaterThan(1);
  });
});
