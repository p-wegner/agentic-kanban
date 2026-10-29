import { describe, it, expect, vi } from "vitest";
import type { WSContext } from "hono/ws";
import { createWorkerConnectionManager } from "../services/worker-connection.service.js";
import { createRemoteLiveness } from "../services/agent-remote-liveness.js";
import type { WorkerRegistry } from "../services/worker-registry.service.js";
import type { RemoteSession } from "../services/agent-remote.types.js";
import { WORKER_DUPLICATE_IDENTITY_CLOSE_CODE } from "@agentic-kanban/shared/lib/worker-protocol";

const registry = { onRevoke: () => {}, touchHeartbeat: async () => {}, noteAttestedProfiles: () => {}, notePackageManagers: () => {}, noteProviderNotice: () => {}, noteDoctor: () => {}, noteCapabilities: async () => {} } as unknown as WorkerRegistry;

function fakeSocket() {
  const close = vi.fn();
  return { ws: { send: () => {}, close } as unknown as WSContext, close };
}

describe("two daemons sharing one pairing (#1754)", () => {
  it("refuses a second process's hello while the first still answers, and records it", () => {
    const mgr = createWorkerConnectionManager(registry);
    const dups: unknown[] = [];
    mgr.onDuplicateIdentity((id, info) => dups.push({ id, ...info }));
    const a = fakeSocket();
    const b = fakeSocket();
    mgr.handleOpen("w1", a.ws);
    mgr.handleMessage("w1", { type: "hello", workerId: "w1", runningSessionIds: ["s1"], instanceId: "A" }, a.ws);
    mgr.handleOpen("w1", b.ws);
    mgr.handleMessage("w1", { type: "hello", workerId: "w1", runningSessionIds: [], instanceId: "B" }, b.ws);

    expect(b.close).toHaveBeenCalledWith(WORKER_DUPLICATE_IDENTITY_CLOSE_CODE, expect.stringContaining("duplicate identity"));
    expect(a.close).not.toHaveBeenCalled();
    expect(mgr.runningSessionIds("w1")).toEqual(["s1"]);
    expect(dups).toEqual([{ id: "w1", heldInstanceId: "A", newInstanceId: "B" }]);
  });

  it("adopts a reconnect from the same process", () => {
    const mgr = createWorkerConnectionManager(registry);
    const a = fakeSocket();
    const a2 = fakeSocket();
    mgr.handleOpen("w1", a.ws);
    mgr.handleMessage("w1", { type: "hello", workerId: "w1", runningSessionIds: [], instanceId: "A" }, a.ws);
    mgr.handleOpen("w1", a2.ws);
    mgr.handleMessage("w1", { type: "hello", workerId: "w1", runningSessionIds: ["s2"], instanceId: "A" }, a2.ws);
    expect(a.close).toHaveBeenCalled();
    expect(a2.close).not.toHaveBeenCalled();
    expect(mgr.runningSessionIds("w1")).toEqual(["s2"]);
  });

  it("does not finalize the first daemon's session on a hello from a different instance", () => {
    vi.useFakeTimers();
    try {
      const sessions = new Map<string, RemoteSession>([["s1", { workerId: "w1", observed: true } as RemoteSession]]);
      const loseSession = vi.fn();
      const liveness = createRemoteLiveness({
        sessions,
        send: () => true,
        assignedInstanceOf: () => "A",
        loseSession,
        assignmentLost: vi.fn(),
        finalizeExited: vi.fn(),
        report: vi.fn(),
        assignSettleMs: 1000,
        log: () => {},
      });
      liveness.reconcileHello("w1", [], "B");
      vi.advanceTimersByTime(5000);
      expect(loseSession).not.toHaveBeenCalled();
      liveness.reconcileHello("w1", [], "A");
      vi.advanceTimersByTime(5000);
      expect(loseSession).toHaveBeenCalledWith("s1", "w1");
    } finally {
      vi.useRealTimers();
    }
  });
});
