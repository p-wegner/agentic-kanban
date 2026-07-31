import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import {
  createWorkerRegistry,
  PAIRING_TOKEN_TTL_MS,
  WORKER_HEARTBEAT_STALE_MS,
  type WorkerRegistry,
} from "../services/worker-registry.service.js";
import type { Database } from "../db/index.js";

describe("worker-registry (worker fleet phase 1a)", () => {
  let db: TestDb;
  let registry: WorkerRegistry;

  beforeEach(() => {
    db = createTestDb().db;
    registry = createWorkerRegistry(db as unknown as Database);
  });

  async function registerOne(name = "builder-1") {
    const { pairingToken } = registry.mintPairingToken();
    const result = await registry.registerWorker({
      pairingToken,
      name,
      os: "win32",
      labels: ["docker"],
      providers: ["claude"],
      maxConcurrency: 2,
    });
    if (!result.ok) throw new Error(`register failed: ${result.error}`);
    return result;
  }

  describe("pairing flow", () => {
    it("registers a worker with a freshly minted pairing token", async () => {
      const result = await registerOne();
      expect(result.workerId).toBeTruthy();
      expect(result.workerToken).toMatch(/^[0-9a-f]{64}$/);
      const [worker] = await registry.listWorkersView();
      expect(worker.name).toBe("builder-1");
      expect(worker.effectiveStatus).toBe("online");
      expect(worker.maxConcurrency).toBe(2);
      // The token itself is never stored — only its hash.
      expect(worker.tokenHash).not.toBe(result.workerToken);
    });

    it("rejects an unknown pairing token", async () => {
      const result = await registry.registerWorker({ pairingToken: "bogus", name: "w" });
      expect(result).toEqual({ ok: false, error: "invalid or expired pairing token" });
    });

    it("pairing tokens are single-use", async () => {
      const { pairingToken } = registry.mintPairingToken();
      const first = await registry.registerWorker({ pairingToken, name: "first" });
      expect(first.ok).toBe(true);
      const second = await registry.registerWorker({ pairingToken, name: "second" });
      expect(second.ok).toBe(false);
    });

    it("pairing tokens expire", async () => {
      const minted = registry.mintPairingToken(new Date(0).toISOString());
      const afterExpiry = new Date(PAIRING_TOKEN_TTL_MS + 1000).toISOString();
      const result = await registry.registerWorker({
        pairingToken: minted.pairingToken,
        name: "late",
        now: afterExpiry,
      });
      expect(result.ok).toBe(false);
    });

    it("requires a name", async () => {
      const { pairingToken } = registry.mintPairingToken();
      const result = await registry.registerWorker({ pairingToken, name: "  " });
      expect(result).toEqual({ ok: false, error: "name is required" });
    });
  });

  describe("worker token auth", () => {
    it("accepts the issued token and rejects wrong ones", async () => {
      const { workerId, workerToken } = await registerOne();
      expect(await registry.authenticateWorker(workerId, workerToken)).toBe(true);
      expect(await registry.authenticateWorker(workerId, "0".repeat(64))).toBe(false);
      expect(await registry.authenticateWorker(workerId, "")).toBe(false);
      expect(await registry.authenticateWorker("no-such-worker", workerToken)).toBe(false);
    });

    it("fails closed after revocation", async () => {
      const { workerId, workerToken } = await registerOne();
      expect(await registry.revokeWorker(workerId)).toBe(true);
      expect(await registry.authenticateWorker(workerId, workerToken)).toBe(false);
      expect(await registry.revokeWorker(workerId)).toBe(false);
    });
  });

  describe("heartbeat and staleness", () => {
    it("rejects a heartbeat with a bad token", async () => {
      const { workerId } = await registerOne();
      const result = await registry.heartbeat(workerId, "wrong");
      expect(result).toEqual({ ok: false, error: "unauthorized" });
    });

    it("updates lastHeartbeatAt and optionally status", async () => {
      const { workerId, workerToken } = await registerOne();
      const at = new Date(Date.now() + 5000).toISOString();
      const result = await registry.heartbeat(workerId, workerToken, { status: "draining", now: at });
      expect(result.ok).toBe(true);
      const [worker] = await registry.listWorkersView(at);
      expect(worker.lastHeartbeatAt).toBe(at);
      expect(worker.status).toBe("draining");
      expect(worker.effectiveStatus).toBe("draining");
    });

    it("rejects an invalid status", async () => {
      const { workerId, workerToken } = await registerOne();
      const result = await registry.heartbeat(workerId, workerToken, { status: "busy" as never });
      expect(result.ok).toBe(false);
    });

    it("derives offline once the heartbeat goes stale", async () => {
      const { workerId, workerToken } = await registerOne();
      const t0 = new Date().toISOString();
      await registry.heartbeat(workerId, workerToken, { now: t0 });

      const fresh = new Date(new Date(t0).getTime() + WORKER_HEARTBEAT_STALE_MS - 1000).toISOString();
      const [freshView] = await registry.listWorkersView(fresh);
      expect(freshView.effectiveStatus).toBe("online");

      const stale = new Date(new Date(t0).getTime() + WORKER_HEARTBEAT_STALE_MS + 1000).toISOString();
      const [staleView] = await registry.listWorkersView(stale);
      expect(staleView.effectiveStatus).toBe("offline");
      // The stored status is untouched — offline is derived at read time.
      expect(staleView.status).toBe("online");
    });
  });
});
