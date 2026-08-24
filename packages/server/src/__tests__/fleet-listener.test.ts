// The fleet listener is a SECURITY boundary: it is the only thing bound off
// loopback, so what is NOT mounted on it matters as much as what is. These tests
// assert the negative space (board API unreachable, owner endpoints absent) and
// then prove a real worker still completes the whole flow through it.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import {
  startFleetListener,
  resolveFleetPort,
  type FleetListenerHandle,
} from "../services/fleet-listener.service.js";
import { getWorkerFleet, type WorkerFleet } from "../services/worker-fleet.service.js";
import { createFleetWorkersRoute } from "../routes/workers.js";
import { startWorkerDaemon, type WorkerDaemonHandle } from "../worker/worker-daemon.js";

describe("fleet listener", () => {
  let db: Database;
  let fleet: WorkerFleet;
  let listener: FleetListenerHandle;
  let base: string;

  beforeAll(async () => {
    db = createTestDb().db as unknown as Database;
    fleet = getWorkerFleet(db);
    listener = await startFleetListener({
      database: db,
      port: 0,
      host: "127.0.0.1",
      createWorkersRoute: createFleetWorkersRoute,
    });
    base = `http://127.0.0.1:${listener.port}`;
  });

  afterAll(async () => {
    await listener?.close();
  });

  describe("port configuration", () => {
    it("is disabled unless KANBAN_FLEET_PORT is set, and survives a typo", () => {
      expect(resolveFleetPort({})).toBeNull();
      expect(resolveFleetPort({ KANBAN_FLEET_PORT: "" })).toBeNull();
      expect(resolveFleetPort({ KANBAN_FLEET_PORT: "not-a-port" })).toBeNull();
      expect(resolveFleetPort({ KANBAN_FLEET_PORT: "70000" })).toBeNull();
      expect(resolveFleetPort({ KANBAN_FLEET_PORT: "3003" })).toBe(3003);
    });
  });

  describe("exposes ONLY the worker-called surface", () => {
    it("does not serve the board API", async () => {
      // The whole point: none of this is reachable from the network.
      for (const path of ["/api/issues", "/api/projects", "/api/preferences/settings", "/api/workspaces", "/api/sessions"]) {
        const res = await fetch(`${base}${path}`);
        expect(res.status, `${path} must not be served by the fleet listener`).toBe(404);
      }
    });

    it("does not serve the owner-only worker endpoints", async () => {
      // Minting a pairing token off-loopback would let anyone on the network
      // enrol themselves; listing/revoking are administrative.
      const mint = await fetch(`${base}/api/workers/pairing-token`, { method: "POST" });
      expect(mint.status).toBe(404);
      const list = await fetch(`${base}/api/workers`);
      expect(list.status).toBe(404);
      const revoke = await fetch(`${base}/api/workers/some-id`, { method: "DELETE" });
      expect(revoke.status).toBe(404);
    });

    it("serves health unauthenticated on both paths (one probe works on either port)", async () => {
      for (const path of ["/health", "/api/health"]) {
        const res = await fetch(`${base}${path}`);
        expect(res.status, path).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      }
    });
  });

  describe("the worker endpoints it does serve still authenticate", () => {
    it("rejects registration without a valid pairing token", async () => {
      const res = await fetch(`${base}/api/workers/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairingToken: "bogus", name: "intruder" }),
      });
      expect(res.status).toBe(401);
      expect(await fleet.registry.listWorkersView()).toHaveLength(0);
    });

    it("rejects a heartbeat without the worker's token", async () => {
      const res = await fetch(`${base}/api/workers/whatever/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(401);
    });

    it("accepts a genuine pairing token minted on the board side", async () => {
      const { pairingToken } = fleet.registry.mintPairingToken();
      const res = await fetch(`${base}/api/workers/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairingToken, name: "legit" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { workerId: string; workerToken: string };
      expect(body.workerToken).toMatch(/^[0-9a-f]{64}$/);
      await fleet.registry.revokeWorker(body.workerId);
    });
  });

  describe("a real worker completes the flow through it", () => {
    let daemon: WorkerDaemonHandle;
    // #839 — the state file lives INSIDE an `ak-` DIRECTORY rather than being a loose
    // `%TEMP%` file, because the reaper (`helpers/reap-fixture-child-servers.ts`) sweeps
    // stale `ak-*`/`kanban-*` entries only when `statSync(...).isDirectory()` — files are
    // excluded on purpose, since `kanban-session-*.out` transcripts are read by a running
    // server. A loose `fleet-listener-*.json` was therefore in no swept namespace at all and
    // a teardown that failed for any reason leaked it permanently; a directory self-heals.
    const fixtureDir = mkdtempSync(join(tmpdir(), "ak-fleet-listener-"));
    const stateFile = join(fixtureDir, `worker-state-${randomUUID()}.json`);

    afterAll(async () => {
      // `stop()` is ASYNC and DRAINS (#754). Unawaited it both races the `rmSync` below and
      // leaves its promise unhandled, so a rejection in shutdown is reported against whatever
      // file vitest runs NEXT — the cross-file misattribution of #680 (#777, #816).
      await daemon?.stop({ killAgents: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("pairs, connects over the WebSocket, and can be assigned work", async () => {
      const { pairingToken } = fleet.registry.mintPairingToken();
      daemon = await startWorkerDaemon({
        boardUrl: base, pairingToken, name: "through-fleet-port", stateFile, log: () => {},
      });
      await daemon.connected;

      expect(fleet.connections.isConnected(daemon.workerId)).toBe(true);
      await vi.waitFor(async () => {
        const [worker] = await fleet.registry.listWorkersView();
        expect(worker?.effectiveStatus).toBe("online");
      });

      // The board can reach it — assignments flow over this listener's socket.
      const sent = fleet.connections.send(daemon.workerId, { type: "stop", sessionId: "nonexistent" });
      expect(sent).toBe(true);
    }, 45000);
  });
}, 90000);
