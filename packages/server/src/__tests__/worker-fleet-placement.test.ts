import { describe, it, expect, beforeEach } from "vitest";
import { preferences } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import type { WSContext } from "hono/ws";
import {
  getWorkerFleet,
  resolveWorkerPlacement,
  selectWorkerForLaunch,
  workerDispatchPrefKey,
  type WorkerFleet,
} from "../services/worker-fleet.service.js";

const PROJECT_ID = "aaaa1111-2222-3333-4444-555566667777";

function fakeWs(): WSContext {
  return { send: () => {}, close: () => {} } as unknown as WSContext;
}

describe("worker-fleet placement (phase 1c)", () => {
  let db: Database;
  let fleet: WorkerFleet;

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
    fleet = getWorkerFleet(db);
  });

  async function optIn() {
    await db.insert(preferences).values({ key: workerDispatchPrefKey(PROJECT_ID), value: "true" });
  }

  async function registerWorker(overrides?: { providers?: string[]; maxConcurrency?: number; name?: string }) {
    const { pairingToken } = fleet.registry.mintPairingToken();
    const result = await fleet.registry.registerWorker({
      pairingToken,
      name: overrides?.name ?? "w",
      providers: overrides?.providers,
      maxConcurrency: overrides?.maxConcurrency,
    });
    if (!result.ok) throw new Error(result.error);
    return result.workerId;
  }

  it("defaults to host when the project has not opted in", async () => {
    const placement = await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    expect(placement).toEqual({ kind: "host" });
  });

  it("falls back to host when opted in but no worker is connected", async () => {
    await optIn();
    await registerWorker(); // registered but never connected a socket
    const placement = await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    expect(placement).toEqual({ kind: "host" });
  });

  it("places on a connected, online, provider-matching worker", async () => {
    await optIn();
    const workerId = await registerWorker({ providers: ["claude"] });
    fleet.connections.handleOpen(workerId, fakeWs());
    const placement = await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    expect(placement).toEqual({ kind: "remote", workerId });
  });

  it("filters by provider", async () => {
    await optIn();
    const codexOnly = await registerWorker({ providers: ["codex"] });
    fleet.connections.handleOpen(codexOnly, fakeWs());
    const placement = await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    expect(placement).toEqual({ kind: "host" });
  });

  it("respects capacity and prefers the least-loaded worker", async () => {
    const busy = await registerWorker({ name: "busy", maxConcurrency: 1 });
    const idle = await registerWorker({ name: "idle", maxConcurrency: 1 });
    fleet.connections.handleOpen(busy, fakeWs());
    fleet.connections.handleOpen(idle, fakeWs());
    // The busy worker announces one running session — at capacity.
    fleet.connections.handleMessage(busy, JSON.stringify({ type: "hello", workerId: busy, runningSessionIds: ["s1"] }));

    expect(await selectWorkerForLaunch(fleet, "claude")).toBe(idle);

    fleet.connections.handleMessage(idle, JSON.stringify({ type: "hello", workerId: idle, runningSessionIds: ["s2"] }));
    expect(await selectWorkerForLaunch(fleet, "claude")).toBeNull();
  });
});
