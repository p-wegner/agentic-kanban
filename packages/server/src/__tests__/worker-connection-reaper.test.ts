// #706 — the stale worker-connection reaper.
//
// The bug it exists for is a LIE in displayed state, not a dispatch fault: nothing ever
// removed a socket whose peer vanished without delivering a close, so `isConnected` kept
// returning true for a dead worker. These tests pin the three cases that matter and, just
// as importantly, pin what the reaper must NOT do — an over-eager version that closes a
// live worker's socket would be a far worse bug than the one being fixed.

import { describe, expect, it, vi } from "vitest";
import { reapStaleWorkerConnections } from "../services/worker-connection-reaper.service.js";
import type { WorkerConnectionManager } from "../services/worker-connection.service.js";
import type { WorkerRegistry } from "../services/worker-registry.service.js";

type WorkerView = Awaited<ReturnType<WorkerRegistry["listWorkersView"]>>[number];

function workerView(id: string, effectiveStatus: "online" | "offline" | "busy"): WorkerView {
  return { id, effectiveStatus } as unknown as WorkerView;
}

/** A connection manager whose only real state is which ids are "connected". */
function fakeConnections(connected: string[]) {
  const live = new Set(connected);
  const closed: Array<{ workerId: string; reason: string }> = [];
  const manager = {
    connectedWorkerIds: () => [...live],
    closeConnection: (workerId: string, reason = "revoked") => {
      if (!live.has(workerId)) return false;
      live.delete(workerId);
      closed.push({ workerId, reason });
      return true;
    },
  } as unknown as WorkerConnectionManager;
  return { manager, closed, live };
}

function fakeRegistry(workers: WorkerView[]): WorkerRegistry {
  return { listWorkersView: vi.fn().mockResolvedValue(workers) } as unknown as WorkerRegistry;
}

describe("reapStaleWorkerConnections (#706)", () => {
  it("closes the socket of a worker whose heartbeat has aged out", async () => {
    const { manager, closed, live } = fakeConnections(["w-dead"]);
    const registry = fakeRegistry([workerView("w-dead", "offline")]);

    const result = await reapStaleWorkerConnections({ registry, connections: manager });

    expect(result.reaped).toEqual(["w-dead"]);
    expect(closed).toEqual([{ workerId: "w-dead", reason: "heartbeat_stale" }]);
    // The whole point: the map must stop claiming the dead peer is connected.
    expect(live.has("w-dead")).toBe(false);
  });

  it("leaves a live worker's socket completely alone", async () => {
    const { manager, closed, live } = fakeConnections(["w-live"]);
    const registry = fakeRegistry([workerView("w-live", "online")]);

    const result = await reapStaleWorkerConnections({ registry, connections: manager });

    expect(result.reaped).toEqual([]);
    expect(closed).toEqual([]);
    expect(live.has("w-live")).toBe(true);
    expect(result.reasons).toEqual([{ id: "w-live", reason: "live" }]);
    expect(result.skipped).toBe(1);
  });

  it("closes a socket for a worker that is no longer registered at all", async () => {
    const { manager, closed } = fakeConnections(["w-ghost"]);
    const registry = fakeRegistry([]);

    const result = await reapStaleWorkerConnections({ registry, connections: manager });

    expect(result.reaped).toEqual(["w-ghost"]);
    expect(closed).toEqual([{ workerId: "w-ghost", reason: "unregistered" }]);
  });

  it("reaps only the dead peers when live and dead workers are connected together", async () => {
    const { manager, live } = fakeConnections(["a-live", "b-dead", "c-live"]);
    const registry = fakeRegistry([
      workerView("a-live", "online"),
      workerView("b-dead", "offline"),
      workerView("c-live", "busy"),
    ]);

    const result = await reapStaleWorkerConnections({ registry, connections: manager });

    expect(result.reaped).toEqual(["b-dead"]);
    expect([...live].sort()).toEqual(["a-live", "c-live"]);
    expect(result.scanned).toBe(3);
  });

  it("does not query the registry when nothing is connected", async () => {
    const { manager } = fakeConnections([]);
    const registry = fakeRegistry([]);

    const result = await reapStaleWorkerConnections({ registry, connections: manager });

    expect(result.scanned).toBe(0);
    expect(result.reaped).toEqual([]);
    expect(registry.listWorkersView).not.toHaveBeenCalled();
  });

  it("records a socket that closed underneath it as skipped, not reaped", async () => {
    // connectedWorkerIds() is a snapshot; a real close can land before closeConnection.
    const registry = fakeRegistry([workerView("w-racing", "offline")]);
    const manager = {
      connectedWorkerIds: () => ["w-racing"],
      closeConnection: () => false,
    } as unknown as WorkerConnectionManager;

    const result = await reapStaleWorkerConnections({ registry, connections: manager });

    expect(result.reaped).toEqual([]);
    expect(result.reasons).toEqual([{ id: "w-racing", reason: "already_closed" }]);
    expect(result.skipped).toBe(1);
  });

  it("passes `now` through to the registry, so staleness is evaluated at the given instant", async () => {
    const { manager } = fakeConnections(["w1"]);
    const registry = fakeRegistry([workerView("w1", "online")]);
    const now = new Date(Date.now() - 5_000).toISOString();

    await reapStaleWorkerConnections({ registry, connections: manager }, now);

    expect(registry.listWorkersView).toHaveBeenCalledWith(now);
  });
});
