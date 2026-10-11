import { describe, it, expect, vi, afterEach } from "vitest";
import type { WSContext } from "hono/ws";
import { createWorkerConnectionManager, WS_KEEPALIVE_MAX_MISSED } from "../services/worker-connection.service.js";
import type { WorkerRegistry } from "../services/worker-registry.service.js";

function fakeRegistry(): WorkerRegistry {
  return { onRevoke: () => {}, touchHeartbeat: async () => {}, noteAttestedProfiles: () => {}, notePackageManagers: () => {}, noteProviderNotice: () => {}, noteDoctor: () => {} } as unknown as WorkerRegistry;
}

/** A socket whose peer is gone: pings are accepted, pongs never come back. */
function deadSocket() {
  const listeners: Record<string, () => void> = {};
  const raw = { ping: vi.fn(), on: (e: string, l: () => void) => { listeners[e] = l; } };
  const ws = { send: () => {}, close: vi.fn(), raw } as unknown as WSContext;
  return { ws, raw, pong: () => listeners.pong?.() };
}

afterEach(() => vi.restoreAllMocks());

describe("worker connection keepalive (#1335)", () => {
  it("drops a socket that stops answering pings and reads disconnected", () => {
    const mgr = createWorkerConnectionManager(fakeRegistry());
    const gone: string[] = [];
    mgr.onDisconnect((id) => gone.push(id));
    const { ws, raw } = deadSocket();
    mgr.handleOpen("w1", ws);
    for (let i = 0; i < WS_KEEPALIVE_MAX_MISSED; i++) {
      expect(mgr.keepaliveTick()).toEqual([]);
      expect(mgr.isConnected("w1")).toBe(true);
    }
    expect(mgr.keepaliveTick()).toEqual(["w1"]);
    expect(raw.ping).toHaveBeenCalledTimes(WS_KEEPALIVE_MAX_MISSED);
    expect(mgr.isConnected("w1")).toBe(false);
    expect(mgr.send("w1", { type: "ping" } as never)).toBe(false);
    expect(gone).toEqual(["w1"]);
  });

  it("keeps a socket that answers with pongs", () => {
    const mgr = createWorkerConnectionManager(fakeRegistry());
    const { ws, pong } = deadSocket();
    mgr.handleOpen("w1", ws);
    for (let i = 0; i < 6; i++) {
      mgr.keepaliveTick();
      pong();
    }
    expect(mgr.isConnected("w1")).toBe(true);
    mgr.closeConnection("w1");
  });

  it("logs a dead link replaced, not overlapping sockets, when the evicted socket missed a ping", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const mgr = createWorkerConnectionManager(fakeRegistry());
    mgr.handleOpen("w1", deadSocket().ws);
    mgr.keepaliveTick();
    mgr.handleOpen("w1", deadSocket().ws);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("replacing dead link"))).toBe(true);
    expect(lines.some((l) => l.includes("overlapping sockets"))).toBe(false);
    mgr.closeConnection("w1");
  });

  it("still logs overlapping sockets when the evicted socket was healthy", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const mgr = createWorkerConnectionManager(fakeRegistry());
    mgr.handleOpen("w1", deadSocket().ws);
    mgr.handleOpen("w1", deadSocket().ws);
    expect(log.mock.calls.some((c) => String(c[0]).includes("overlapping sockets"))).toBe(true);
    mgr.closeConnection("w1");
  });
});
