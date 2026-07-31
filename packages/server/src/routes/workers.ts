import type { Context, Hono } from "hono";
import { createRouter } from "../middleware/create-router.js";
import { parseOptionalJsonBody } from "../middleware/parse-body.js";
import type { Database } from "../db/index.js";
import {
  getWorkerRegistry,
  type WorkerRegistry,
  type WorkerStatus,
} from "../services/worker-registry.service.js";

function extractBearer(c: Context): string | null {
  const header = c.req.header("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/**
 * Worker-fleet control plane (epic #1, phase 1a #3).
 *
 * Two trust zones on one router:
 *  - Owner surface (pairing-token mint, list, revoke) rides the board's
 *    loopback trust model like every other REST route.
 *  - Worker surface (register, heartbeat) is called by remote machines and
 *    authenticates per request — pairing token at registration, per-worker
 *    bearer token afterwards — so it stays safe when the listener is opened
 *    beyond loopback for the fleet.
 */
/**
 * Owner-only endpoints. These stay on the LOOPBACK app forever: minting a
 * pairing token, listing the fleet and revoking a worker are administrative
 * actions with no credential of their own — they ride the board's
 * "only reachable from this machine" trust, exactly like the rest of /api.
 */
function registerOwnerRoutes(router: Hono, reg: WorkerRegistry): void {
  router.post("/pairing-token", (c) => c.json(reg.mintPairingToken(), 201));

  router.get("/", async (c) => {
    return c.json({ workers: await reg.listWorkersView() });
  });

  router.delete("/:id", async (c) => {
    const ok = await reg.revokeWorker(c.req.param("id"));
    if (!ok) return c.json({ error: "worker not found" }, 404);
    return c.json({ ok: true });
  });
}

/**
 * Worker-called endpoints. Every one authenticates for itself — a pairing token
 * at registration, the per-worker bearer token afterwards — so this is the ONLY
 * HTTP surface safe to expose off-loopback, and the fleet listener serves
 * exactly this and nothing else.
 */
function registerWorkerFacingRoutes(router: Hono, reg: WorkerRegistry): void {
  router.post("/register", async (c) => {
    const body = await parseOptionalJsonBody<{
      pairingToken?: string;
      name?: string;
      os?: string;
      arch?: string;
      labels?: string[];
      providers?: string[];
      maxConcurrency?: number;
    }>(c);
    const result = await reg.registerWorker({
      pairingToken: body.pairingToken ?? "",
      name: body.name ?? "",
      os: body.os,
      arch: body.arch,
      labels: body.labels,
      providers: body.providers,
      maxConcurrency: body.maxConcurrency,
    });
    if (!result.ok) {
      const status = result.error.includes("pairing token") ? 401 : 422;
      return c.json({ error: result.error }, status);
    }
    return c.json(result, 201);
  });

  router.post("/:id/heartbeat", async (c) => {
    const token = extractBearer(c);
    const body = await parseOptionalJsonBody<{ status?: WorkerStatus }>(c);
    const result = await reg.heartbeat(c.req.param("id"), token ?? "", { status: body.status });
    if (!result.ok) {
      return c.json({ error: result.error }, result.error === "unauthorized" ? 401 : 422);
    }
    return c.json({ ok: true });
  });
}

/** The full surface, mounted on the main (loopback) app at /api/workers. */
export function createWorkersRoute(database: Database, registry?: WorkerRegistry) {
  const router = createRouter();
  const reg = registry ?? getWorkerRegistry(database);
  registerOwnerRoutes(router, reg);
  registerWorkerFacingRoutes(router, reg);
  return router;
}

/**
 * The worker-called subset ONLY — for the off-loopback fleet listener.
 *
 * Splitting by AUDIENCE rather than by URL prefix is the point: it makes
 * "the board API is not reachable from the network" a property of what is
 * mounted where, instead of a warning in the docs that a misconfiguration can
 * quietly violate.
 */
export function createFleetWorkersRoute(database: Database, registry?: WorkerRegistry) {
  const router = createRouter();
  registerWorkerFacingRoutes(router, registry ?? getWorkerRegistry(database));
  return router;
}
