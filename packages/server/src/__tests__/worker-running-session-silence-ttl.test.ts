// #883 — the running half of a worker's load had no liveness bound.
//
// `assignedSessionIds()` is what capacity decisions read, and it is the union of two
// sets that aged completely differently: `pendingSessionIds` expired on a TTL (#248,
// "a dispatch that vanished without a trace cannot pin capacity forever"), while
// `runningSessionIds` left only on an `exit` frame. So an agent that emitted one byte
// and then hung — zombied, never reaped by the worker — pinned a slot for the whole
// life of that socket, and four of them made a `maxConcurrency: 4` worker permanently
// ineligible. A `hello` cured it, but only on reconnect.
//
// These tests pin the bound AND, just as importantly, the two things it must not do:
// evict a session that is merely quiet-but-recent, and contradict the worker's own
// declaration of what it holds.

import { describe, expect, it, vi } from "vitest";
import {
  RUNNING_SESSION_SILENCE_TTL_MS,
  PENDING_ASSIGN_TTL_MS,
  createWorkerConnectionManager,
} from "../services/worker-connection.service.js";
import type { WorkerRegistry } from "../services/worker-registry.service.js";
import type { WSContext } from "hono/ws";

function fakeRegistry(): WorkerRegistry {
  return {
    onRevoke: vi.fn(),
    touchHeartbeat: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkerRegistry;
}

function fakeSocket(): WSContext {
  return { close: vi.fn(), send: vi.fn() } as unknown as WSContext;
}

/** A manager with one connected worker, ready to be fed messages. */
function connectedWorker() {
  const manager = createWorkerConnectionManager(fakeRegistry());
  manager.handleOpen("w-1", fakeSocket());
  return manager;
}

describe("running-session silence TTL (#883)", () => {
  it("stops counting a running session that has been silent past the TTL", () => {
    const manager = connectedWorker();
    manager.handleMessage("w-1", { type: "event", event: { type: "stdout", sessionId: "s-zombie", data: "hi" } });

    // Immediately after its one and only event it counts, exactly as before.
    expect(manager.assignedSessionIds("w-1")).toEqual(["s-zombie"]);

    const later = Date.now() + RUNNING_SESSION_SILENCE_TTL_MS + 1;
    expect(manager.assignedSessionIds("w-1", later)).toEqual([]);
  });

  it("keeps counting a session that is merely quiet — over-dispatch is the worse failure", () => {
    const manager = connectedWorker();
    manager.handleMessage("w-1", { type: "event", event: { type: "stdout", sessionId: "s-thinking", data: "…" } });

    // A cold install or a full test suite can easily be this quiet and still be live.
    const stillWithin = Date.now() + RUNNING_SESSION_SILENCE_TTL_MS - 60_000;
    expect(manager.assignedSessionIds("w-1", stillWithin)).toEqual(["s-thinking"]);
  });

  it("restarts the clock on every event, so a chatty long-running session never ages out", () => {
    const manager = connectedWorker();
    manager.handleMessage("w-1", { type: "event", event: { type: "stdout", sessionId: "s-live", data: "a" } });
    // A second event arrives; the stamp is refreshed to now.
    manager.handleMessage("w-1", { type: "event", event: { type: "stdout", sessionId: "s-live", data: "b" } });

    const later = Date.now() + RUNNING_SESSION_SILENCE_TTL_MS - 1;
    expect(manager.assignedSessionIds("w-1", later)).toEqual(["s-live"]);
  });

  it("a `hello` restarts the clock for everything the worker declares", () => {
    const manager = connectedWorker();
    manager.handleMessage("w-1", { type: "event", event: { type: "stdout", sessionId: "s-old", data: "a" } });

    // Long after s-old would have aged out, the worker reconnects and vouches for it.
    // Without a fresh stamp the reconnect would inherit an expired one and evict a
    // session the worker just said it is holding.
    manager.handleMessage("w-1", { type: "hello", workerId: "w-1", runningSessionIds: ["s-old"] });
    const afterOldTtl = Date.now() + RUNNING_SESSION_SILENCE_TTL_MS - 1;
    expect(manager.assignedSessionIds("w-1", afterOldTtl)).toEqual(["s-old"]);
  });

  it("does NOT remove the session from `runningSessionIds` — the worker's declaration stands", () => {
    const manager = connectedWorker();
    manager.handleMessage("w-1", { type: "event", event: { type: "stdout", sessionId: "s-zombie", data: "hi" } });

    const later = Date.now() + RUNNING_SESSION_SILENCE_TTL_MS + 1;
    expect(manager.assignedSessionIds("w-1", later)).toEqual([]);
    // The board declines to COUNT it; it does not claim the worker isn't holding it.
    expect(manager.runningSessionIds("w-1")).toEqual(["s-zombie"]);
  });

  it("an exit frame still clears the session outright", () => {
    const manager = connectedWorker();
    manager.handleMessage("w-1", { type: "event", event: { type: "stdout", sessionId: "s-done", data: "hi" } });
    manager.handleMessage("w-1", { type: "event", event: { type: "exit", sessionId: "s-done", exitCode: 0 } });

    expect(manager.assignedSessionIds("w-1")).toEqual([]);
    expect(manager.runningSessionIds("w-1")).toEqual([]);
  });

  it("the running bound is far longer than the pending one, and that asymmetry is deliberate", () => {
    // A pending session has produced nothing, so expiring one early costs a
    // re-dispatch. A running session is a live agent, and evicting it early causes
    // over-dispatch. If these ever converge, re-read the reasoning before changing it.
    expect(RUNNING_SESSION_SILENCE_TTL_MS).toBeGreaterThan(PENDING_ASSIGN_TTL_MS * 6);
  });
});
