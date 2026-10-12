import { describe, it, expect } from "vitest";
import type { WSContext } from "hono/ws";
import { createWorkerConnectionManager } from "../services/worker-connection.service.js";
import type { WorkerRegistry } from "../services/worker-registry.service.js";

const registry = { onRevoke: () => {}, touchHeartbeat: async () => {}, noteAttestedProfiles: () => {}, notePackageManagers: () => {}, noteProviderNotice: () => {}, noteProviderNotice2: () => {}, noteDoctor: () => {}, noteCapabilities: async () => {} } as unknown as WorkerRegistry;

describe("board-ended sessions release their worker slot (#1415)", () => {
  it("a `stop` frees a pending and a running assignment", () => {
    const mgr = createWorkerConnectionManager(registry);
    mgr.handleOpen("w1", { send: () => {}, close: () => {} } as unknown as WSContext);
    mgr.handleMessage("w1", { type: "hello", workerId: "w1", runningSessionIds: ["run1"] });
    mgr.send("w1", { type: "assign", sessionId: "pend1" } as never);
    expect(mgr.assignedSessionIds("w1").sort()).toEqual(["pend1", "run1"]);
    mgr.send("w1", { type: "stop", sessionId: "pend1" });
    mgr.send("w1", { type: "stop", sessionId: "run1" });
    expect(mgr.assignedSessionIds("w1")).toEqual([]);
  });
});
