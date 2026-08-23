/**
 * The two route changes of #774 (remaining #755 items 1 and 2), against a real Hono surface.
 *
 * ITEM 2's defect was not "the panel is thin" — it was that the list route answered the raw
 * `workers` DB row, so `connected` and `load` did not exist client-side at all and the panel
 * had to INVENT a capacity number from `maxConcurrency`. Total capacity presented as free
 * capacity reads as spare room while every slot is busy. So the assertions below are about
 * the SHAPE the route hands out: the live fields must be there, and `fleet.freeSlots` must be
 * a real free-slot count rather than a sum of concurrency limits.
 *
 * ITEM 1's endpoint gets the same treatment: an event has to survive the request that made
 * it, and a revoke has to take the timeline with it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createWorkersRoute } from "../routes/workers.js";
import { getWorkerFleet } from "../services/worker-fleet.service.js";
import type { Database } from "../db/index.js";

interface WorkerRowShape {
  id: string;
  workerId: string;
  name: string;
  labels: string[];
  providers: string[];
  connected: boolean;
  load: number;
  freeSlots: number;
  maxConcurrency: number;
  eligible: boolean;
  ineligibleReason: string | null;
}

describe("worker fleet observability routes", () => {
  let db: TestDb;
  let dispose: () => void;
  let server: ReturnType<typeof serve>;
  let base: string;

  beforeAll(async () => {
    ({ db, dispose } = createTestDb());
    const app = new Hono();
    // The route resolves its fleet from the SAME database, so the registry the route mints
    // and the one `describeFleet` reads are one object (`fleetByDb`).
    const fleet = getWorkerFleet(db as unknown as Database);
    app.route("/api/workers", createWorkersRoute(db as unknown as Database, fleet.registry));
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

  async function registerWorker(name: string, maxConcurrency = 2): Promise<string> {
    const mint = await fetch(`${base}/api/workers/pairing-token`, { method: "POST" });
    const { pairingToken } = (await mint.json()) as { pairingToken: string };
    const res = await fetch(`${base}/api/workers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingToken,
        name,
        os: "linux",
        arch: "x64",
        labels: ["docker", "linux"],
        providers: ["claude"],
        maxConcurrency,
      }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { workerId: string }).workerId;
  }

  it("serves live per-worker state and a real free-slot count, not a maxConcurrency sum", async () => {
    const workerId = await registerWorker("buildbox", 4);

    const res = await fetch(`${base}/api/workers`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workers: WorkerRowShape[]; fleet: Record<string, unknown> };

    const row = body.workers.find((w) => w.workerId === workerId);
    expect(row).toBeDefined();
    // `id` is kept alongside `workerId`: every existing consumer (CLI `worker list`, the
    // panel's revoke) has read `id` since epic #1, so dropping it would be a silent break.
    expect(row!.id).toBe(workerId);
    // The fields the raw DB row could never carry.
    expect(typeof row!.connected).toBe("boolean");
    expect(row!.load).toBe(0);
    expect(row!.freeSlots).toBe(4);
    // Parsed, not the raw JSON TEXT the column stores — the panel used to re-parse it itself.
    expect(row!.labels).toEqual(["docker", "linux"]);
    expect(row!.providers).toEqual(["claude"]);
    // No WebSocket in this test, so the worker is correctly NOT eligible and says why. That
    // is the state that used to be indistinguishable from four other failures.
    expect(row!.connected).toBe(false);
    expect(row!.eligible).toBe(false);
    expect(row!.ineligibleReason).toContain("WebSocket");

    // `freeSlots` counts slots on ELIGIBLE workers. With no socket held, that is zero — a
    // maxConcurrency sum would have reported 4 and read as spare capacity.
    expect(body.fleet.registered).toBe(1);
    expect(body.fleet.eligible).toBe(0);
    expect(body.fleet.freeSlots).toBe(0);
    expect(body.fleet.provider).toBe("claude");
  });

  it("records a registration on the worker's timeline and serves it back", async () => {
    const workerId = await registerWorker("historian");

    // The event write is fire-and-forget by design (a diagnostic must not be able to fail a
    // registration), so poll briefly rather than assuming it landed within the response.
    let events: Array<{ type: string; summary: string; payload: Record<string, unknown> | null }> = [];
    for (let i = 0; i < 20 && events.length === 0; i++) {
      const res = await fetch(`${base}/api/workers/${workerId}/events`);
      expect(res.status).toBe(200);
      events = ((await res.json()) as { events: typeof events }).events;
      if (events.length === 0) await new Promise((r) => setTimeout(r, 25));
    }
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.type).toBe("registered");
    expect(events[0]!.summary).toContain("historian");
    expect(events[0]!.payload).toMatchObject({ providers: ["claude"] });
  });

  it("rejects an unknown event type filter instead of silently returning everything", async () => {
    const workerId = await registerWorker("picky");
    const res = await fetch(`${base}/api/workers/${workerId}/events?types=not_a_type`);
    // A filter the server does not understand must not degrade into "no filter" — that is
    // how a caller ends up believing an empty vocabulary answered.
    expect(res.status).toBe(422);
    const ok = await fetch(`${base}/api/workers/${workerId}/events?types=registered,not_a_type`);
    expect(ok.status).toBe(200);
  });

  it("takes the timeline with the worker on revoke", async () => {
    const workerId = await registerWorker("doomed");
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${base}/api/workers/${workerId}/events`);
      if (((await res.json()) as { events: unknown[] }).events.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const del = await fetch(`${base}/api/workers/${workerId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const body = (await del.json()) as { ok: boolean; eventsDeleted: number };
    expect(body.ok).toBe(true);
    expect(body.eventsDeleted).toBeGreaterThan(0);

    // Awaited inside the handler on purpose: a poll arriving right after a 200 must not
    // still see a revoked worker's history.
    const after = await fetch(`${base}/api/workers/${workerId}/events`);
    expect(((await after.json()) as { events: unknown[] }).events).toEqual([]);
  });
});
