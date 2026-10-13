/**
 * #1381 — per-worker settings edited on the board: stored, pushed in the heartbeat response,
 * overlaid on what placement reads, pinned keys left alone, project lists enforced, audited.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createWorkersRoute } from "../routes/workers.js";
import { getWorkerFleet } from "../services/worker-fleet.service.js";
import { fleetForProject } from "../services/worker-project-scope.js";
import type { Database } from "../db/index.js";

describe("per-worker settings (#1381)", () => {
  let db: TestDb;
  let dispose: () => void;
  let server: ReturnType<typeof serve>;
  let base: string;
  let database: Database;

  beforeAll(async () => {
    ({ db, dispose } = createTestDb());
    database = db as unknown as Database;
    const app = new Hono();
    app.route("/api/workers", createWorkersRoute(database, getWorkerFleet(database).registry));
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        base = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    dispose();
  });

  async function register(name: string): Promise<{ id: string; token: string }> {
    const { pairingToken } = (await (await fetch(`${base}/api/workers/pairing-token`, { method: "POST" })).json()) as { pairingToken: string };
    const res = await fetch(`${base}/api/workers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingToken, name, labels: ["linux"], providers: ["claude"], maxConcurrency: 1 }),
    });
    const body = (await res.json()) as { workerId: string; workerToken: string };
    return { id: body.workerId, token: body.workerToken };
  }

  const put = (id: string, settings: unknown) =>
    fetch(`${base}/api/workers/${id}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    });

  const beat = async (id: string, token: string, body: unknown) => {
    const res = await fetch(`${base}/api/workers/${id}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return (await res.json()) as { ok: boolean; config?: { rev: string; settings: Record<string, unknown> } };
  };

  const listed = async (id: string) => {
    const body = (await (await fetch(`${base}/api/workers`)).json()) as { workers: Array<Record<string, any>> };
    return body.workers.find((w) => w.id === id)!;
  };

  it("pushes concurrency and labels in the heartbeat response and reflects them in the worker list", async () => {
    const { id, token } = await register("live");
    expect((await beat(id, token, {})).config).toBeUndefined();

    const res = await put(id, { maxConcurrency: 4, labels: ["docker", "linux"] });
    expect(res.status).toBe(200);

    const response = await beat(id, token, { settings: { pinned: [] } });
    expect(response.config?.settings).toMatchObject({ maxConcurrency: 4, labels: ["docker", "linux"] });
    const row = await listed(id);
    expect(row.maxConcurrency).toBe(4);
    expect(row.labels).toEqual(["docker", "linux"]);
    expect(row.freeSlots).toBe(4);
    // Not applied until the worker echoes the revision back.
    expect(row.settingsReport.appliedRev).toBeUndefined();
    await beat(id, token, { settings: { pinned: [], appliedRev: response.config!.rev } });
    expect((await listed(id)).settingsReport.appliedRev).toBe(response.config!.rev);
  });

  it("keeps the board's overlay when the worker re-declares its old capabilities", async () => {
    const { id, token } = await register("redeclare");
    await put(id, { maxConcurrency: 3 });
    await beat(id, token, { capabilities: { maxConcurrency: 1, labels: ["linux"] } });
    expect((await listed(id)).maxConcurrency).toBe(3);
  });

  it("does not overlay a key the worker pins with a start flag", async () => {
    const { id, token } = await register("pinned");
    await put(id, { maxConcurrency: 8, labels: ["x"] });
    await beat(id, token, { capabilities: { maxConcurrency: 2, labels: ["linux"] }, settings: { pinned: ["maxConcurrency"] } });
    const row = await listed(id);
    expect(row.maxConcurrency).toBe(2);
    expect(row.settingsReport.pinned).toEqual(["maxConcurrency"]);
    expect(row.labels).toEqual(["x"]);
  });

  it("audits a change in the worker's timeline, naming the keys", async () => {
    const { id } = await register("audited");
    await put(id, { maxConcurrency: 2 });
    await put(id, { maxConcurrency: 2, labels: ["gpu"] });
    let events: Array<{ type: string; summary: string }> = [];
    for (let i = 0; i < 20 && events.filter((e) => e.type === "settings_changed").length < 2; i++) {
      events = ((await (await fetch(`${base}/api/workers/${id}/events`)).json()) as { events: typeof events }).events;
      await new Promise((r) => setTimeout(r, 25));
    }
    const changed = events.filter((e) => e.type === "settings_changed").map((e) => e.summary);
    expect(changed).toHaveLength(2);
    expect(changed.some((s) => s.includes("labels"))).toBe(true);
  });

  it("rejects an invalid concurrency and unknown workers", async () => {
    const { id } = await register("bad");
    expect((await put(id, { maxConcurrency: 0 })).status).toBe(422);
    expect((await put("nope", { maxConcurrency: 2 })).status).toBe(404);
  });

  it("enforces allowed and denied projects through the project-scoped fleet", async () => {
    const open = await register("open");
    const denied = await register("denied");
    const allowOnly = await register("allow-only");
    await put(denied.id, { deniedProjects: ["p1"] });
    await put(allowOnly.id, { allowedProjects: ["p2"] });
    const fleet = getWorkerFleet(database);
    const ids = async (projectId: string) =>
      (await fleetForProject(fleet, projectId).registry.listWorkersView()).map((w) => w.id);
    const forP1 = await ids("p1");
    expect(forP1).toContain(open.id);
    expect(forP1).not.toContain(denied.id);
    expect(forP1).not.toContain(allowOnly.id);
    const forP2 = await ids("p2");
    expect(forP2).toContain(denied.id);
    expect(forP2).toContain(allowOnly.id);
  });

  it("minFreeRamGb makes the worker ineligible with the reason, and eligible again on recovery (#1451)", async () => {
    const { id, token } = await register("ram-floor");
    await put(id, { minFreeRamGb: 8 });
    const cap = (freeRamGb: number) => ({ capabilities: { capacity: { freeRamGb, totalRamGb: 32, freeDiskGb: 120, spareCores: 4, thrashing: "none" }, harnessMode: "clean" } });
    await beat(id, token, cap(4));
    const low = await listed(id);
    expect(low.eligible).toBe(false);
    expect(low.ineligibleReason).toContain("minFreeRamGb 8");
    expect(low.capacity).toMatchObject({ freeRamGb: 4, totalRamGb: 32, freeDiskGb: 120 });
    expect(low.harnessMode).toBe("clean");
    await beat(id, token, cap(12));
    expect((await listed(id)).ineligibleReason ?? "").not.toContain("minFreeRamGb");
  });

  it("drain takes the worker out of rotation at once and undrain returns it", async () => {
    const { id, token } = await register("drainable");
    await beat(id, token, {});
    expect((await listed(id)).effectiveStatus).toBe("online");
    await put(id, { drain: true });
    expect((await listed(id)).effectiveStatus).toBe("draining");
    await put(id, { drain: false });
    expect((await listed(id)).effectiveStatus).toBe("online");
  });

  it("the fleet snapshot (worker explain / list) carries desired settings and pinned keys", async () => {
    const { id, token } = await register("explained");
    await put(id, { deniedProjects: ["proj-x"], labels: ["gpu"] });
    await beat(id, token, { settings: { pinned: ["providers"] } });
    const { describeFleet } = await import("../services/placement-explain.service.js");
    const snapshot = await describeFleet({ database });
    const row = snapshot.workers.find((w) => w.workerId === id)!;
    expect(row.desiredSettings?.settings.deniedProjects).toEqual(["proj-x"]);
    expect(row.settingsReport?.pinned).toEqual(["providers"]);
    expect(row.labels).toEqual(["gpu"]);
  });
});
