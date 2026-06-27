// @covers agent-sessions.stream.live-subscribe [concurrency, state-transition]
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WSContext } from "hono/ws";
import { createSessionState } from "../services/session-manager/types.js";

// Mirror broadcast-batch.test.ts: stub the DB so the broadcaster's
// fire-and-forget persistence (exit flush + friction fallback) is inert.
vi.mock("../db/index.js", () => {
  const mockDb = {
    insert: vi.fn(() => ({ values: vi.fn(() => ({ catch: vi.fn() })) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ stats: null }])) })) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
  };
  return { db: mockDb, writeDb: mockDb };
});

vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "log").mockImplementation(() => {});

const { createBroadcaster } = await import("../services/session-manager/broadcast.js");
const { createWsHandler } = await import("../services/session-manager/ws-handler.js");

// Minimal fake WSContext — only readyState/send are touched by subscribe/broadcast.
function fakeWs(): WSContext {
  return { readyState: 1, send: vi.fn() } as unknown as WSContext;
}

/**
 * This is a multi-subscriber *registry* test (the in-memory subscriber Map per
 * sessionId), not true OS-level parallelism — the bookkeeping that decides when
 * the replay buffer may be freed. The invariant under test (ws-handler.ts
 * `unsubscribe`): the buffer is freed ONLY when the LAST subscriber leaves AND
 * the session has already exited (its last buffered message is `type: "exit"`).
 */
describe("session stream live-subscribe — buffer-free invariant", () => {
  const SID = "s-buffer-free";
  let state: ReturnType<typeof createSessionState>;
  let broadcast: ReturnType<typeof createBroadcaster>;
  let subscribe: (sessionId: string, ws: WSContext) => void;
  let unsubscribe: (sessionId: string, ws: WSContext) => void;

  beforeEach(() => {
    state = createSessionState();
    broadcast = createBroadcaster(state, undefined);
    // wsRoute (the only consumer of upgradeWebSocket) is never called here.
    const handler = createWsHandler(state, (() => undefined) as never);
    subscribe = handler.subscribe;
    unsubscribe = handler.unsubscribe;
  });

  it("retains the buffer while >1 subscriber is attached and the session is live", () => {
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    subscribe(SID, ws1);
    subscribe(SID, ws2);

    broadcast(SID, { type: "stdout", data: "live output" });
    expect(state.messageBuffer.has(SID)).toBe(true);
    expect(state.subscribers.get(SID)!.size).toBe(2);

    // One of two leaves: a subscriber still remains -> buffer retained.
    unsubscribe(SID, ws1);
    expect(state.subscribers.get(SID)!.size).toBe(1);
    expect(state.messageBuffer.has(SID)).toBe(true);
  });

  it("does NOT free the buffer when the LAST subscriber leaves but the session is still live (mutation guard A)", () => {
    const ws1 = fakeWs();
    subscribe(SID, ws1);
    broadcast(SID, { type: "stdout", data: "still running" });

    // Last subscriber leaves, but no exit message has been buffered yet.
    unsubscribe(SID, ws1);

    expect(state.subscribers.has(SID)).toBe(false);
    // Freeing on "last-subscriber-left" ALONE would drop the buffer here -> RED.
    expect(state.messageBuffer.has(SID)).toBe(true);
  });

  it("does NOT free the buffer when the session exits but a subscriber remains (mutation guard B)", () => {
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    subscribe(SID, ws1);
    subscribe(SID, ws2);

    broadcast(SID, { type: "stdout", data: "work" });
    broadcast(SID, { type: "exit", exitCode: 0 });

    // Session has exited, but two subscribers are still attached.
    expect(state.messageBuffer.has(SID)).toBe(true);

    // Drop one — a subscriber still remains, so even with an exit buffered it stays.
    unsubscribe(SID, ws1);
    expect(state.subscribers.get(SID)!.size).toBe(1);
    // Freeing on "session-exited" ALONE would drop the buffer here -> RED.
    expect(state.messageBuffer.has(SID)).toBe(true);
  });

  it("frees the buffer ONLY when the last subscriber leaves AND the session has exited", () => {
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    subscribe(SID, ws1);
    subscribe(SID, ws2);

    broadcast(SID, { type: "stdout", data: "work" });
    broadcast(SID, { type: "exit", exitCode: 0 });

    unsubscribe(SID, ws1);
    expect(state.messageBuffer.has(SID)).toBe(true); // exited but ws2 still here

    unsubscribe(SID, ws2); // last leaves AND already exited -> freed
    expect(state.subscribers.has(SID)).toBe(false);
    expect(state.messageBuffer.has(SID)).toBe(false);
  });
});
