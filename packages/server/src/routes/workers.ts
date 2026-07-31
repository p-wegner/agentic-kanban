import type { Context } from "hono";
import { createRouter } from "../middleware/create-router.js";
import { parseOptionalJsonBody } from "../middleware/parse-body.js";
import type { Database } from "../db/index.js";
import {
  createWorkerRegistry,
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
export function createWorkersRoute(database: Database, registry?: WorkerRegistry) {
  const router = createRouter();
  const reg = registry ?? createWorkerRegistry(database);

  // ── Owner surface (loopback UI/CLI) ────────────────────────────────────────
  router.post("/pairing-token", (c) => c.json(reg.mintPairingToken(), 201));

  router.get("/", async (c) => {
    return c.json({ workers: await reg.listWorkersView() });
  });

  router.delete("/:id", async (c) => {
    const ok = await reg.revokeWorker(c.req.param("id"));
    if (!ok) return c.json({ error: "worker not found" }, 404);
    return c.json({ ok: true });
  });

  // ── Worker surface (token-authed) ──────────────────────────────────────────
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

  return router;
}
