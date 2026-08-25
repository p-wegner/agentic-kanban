// #879 — the board compares each worker's reported build against its OWN package version
// and ships the verdict on the existing `GET /api/workers` rows (sourced from the same
// in-memory `reportedVersions` map, no new persistence, no new wire message).
//
// The two traps the ticket names, pinned end to end:
//  * a worker AHEAD of the board (dev machine) is "ahead-of-board", never a bare
//    "outdated" or "behind";
//  * a worker that reported NO build stays `workerVersion: undefined` with NO
//    buildFreshness at all — never 0, never "current". The registry's "we assumed 1"
//    vs "it said 1" distinction survives the enrichment.
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { WORKER_PROTOCOL_VERSION } from "@agentic-kanban/shared/lib/worker-protocol";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import { createWorkerRegistry } from "../services/worker-registry.service.js";
import { createWorkersRoute } from "../routes/workers.js";
import { resolveOwnPackageVersion } from "../lib/worker-build.js";

interface ListedWorker {
  name: string;
  workerVersion?: string;
  buildFreshness?: string;
}

describe("GET /api/workers carries buildFreshness (#879)", () => {
  let db: Database;
  let app: Hono;

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
    app = new Hono();
    app.route("/api/workers", createWorkersRoute(db, createWorkerRegistry(db)));
  });

  async function registerWorker(name: string, workerVersion?: string): Promise<void> {
    const tokenRes = await app.request("/api/workers/pairing-token", { method: "POST" });
    const { pairingToken } = (await tokenRes.json()) as { pairingToken: string };
    const res = await app.request("/api/workers/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingToken,
        name,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        ...(workerVersion ? { workerVersion } : {}),
      }),
    });
    expect(res.status).toBe(201);
  }

  async function listWorkers(): Promise<{ workers: ListedWorker[]; fleet: { boardWorkerVersion: string | null } }> {
    const res = await app.request("/api/workers");
    expect(res.status).toBe(200);
    return (await res.json()) as { workers: ListedWorker[]; fleet: { boardWorkerVersion: string | null } };
  }

  it("resolves the board's own version at all — the comparison has a real reference", () => {
    // If this fails, every freshness verdict below would be "unknown" and the feature
    // silently inert; better one loud test than a quiet regression.
    expect(resolveOwnPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("marks an older reported build behind-board, and says what the board runs", async () => {
    await registerWorker("old-box", "0.0.1");
    const body = await listWorkers();
    expect(body.workers[0]).toMatchObject({ name: "old-box", workerVersion: "0.0.1", buildFreshness: "behind-board" });
    expect(body.fleet.boardWorkerVersion).toBe(resolveOwnPackageVersion());
  });

  it("marks a newer reported build ahead-of-board — a dev machine is not 'outdated'", async () => {
    await registerWorker("dev-box", "999.0.0");
    const body = await listWorkers();
    expect(body.workers[0]).toMatchObject({ name: "dev-box", buildFreshness: "ahead-of-board" });
  });

  it("marks the board's own version in-sync", async () => {
    await registerWorker("twin-box", resolveOwnPackageVersion()!);
    const body = await listWorkers();
    expect(body.workers[0]!.buildFreshness).toBe("in-sync");
  });

  it("attaches NO freshness to a worker that reported no build — '?' stays '?'", async () => {
    await registerWorker("silent-box");
    const body = await listWorkers();
    const row = body.workers[0]!;
    expect(row.workerVersion).toBeUndefined();
    // Never "current", never a zero — no verdict rides on an assumed version.
    expect(row.buildFreshness).toBeUndefined();
  });
});
