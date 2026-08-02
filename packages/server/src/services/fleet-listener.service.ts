// The off-loopback listener for fleet workers (epic #184).
//
// WHY A SECOND LISTENER. The board's own API has no authentication — its defense
// is that it only listens on 127.0.0.1. A remote worker, however, must reach the
// board over the network. Serving both from one app forces a choice between "no
// fleet" and "bind everything to 0.0.0.0", and the second option publishes
// delete_issue, merge_workspace and every transcript to the LAN with no
// credential. A warning in the docs is not a control.
//
// So the worker-facing endpoints get their own listener, and ONLY those:
//   POST /api/workers/register        (pairing token -> per-worker token)
//   POST /api/workers/:id/heartbeat   (per-worker bearer token)
//   GET  /ws/workers/:id              (per-worker bearer token, checked pre-upgrade)
//   GET  /health, /api/health         (unauthenticated liveness, like the others)
// Every one of them authenticates for itself, so this surface is safe to expose
// while the main app stays on loopback permanently. The owner-only endpoints
// (mint/list/revoke) are deliberately NOT here — see routes/workers.ts.
//
// Opt-in: nothing is exposed unless KANBAN_FLEET_PORT is set. Same-machine
// workers keep talking to the main board port, which still serves the full
// surface on loopback, so enabling this breaks nothing.

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { Database } from "../db/index.js";
import { createWorkerWsRoute } from "./worker-connection.service.js";
import { getWorkerFleet } from "./worker-fleet.service.js";
import type { WorkerRegistry } from "./worker-registry.service.js";

/**
 * Factory for the owner+worker-facing `/api/workers` router. Injected by the
 * caller (server-start.ts) instead of imported directly — services must not
 * depend on the transport layer (routes/), so this stays a parameter, not an
 * import, per the routes<-services layering rule.
 */
export type CreateWorkersRoute = (database: Database, registry: WorkerRegistry) => Hono;

export interface FleetListenerHandle {
  port: number;
  close(): Promise<void>;
}

/**
 * Resolve the configured fleet port. Absent/empty = disabled (the default: a
 * single-machine board must not open a network port just by existing). Invalid
 * values warn and disable rather than crashing the board on a typo.
 */
export function resolveFleetPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.KANBAN_FLEET_PORT;
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    console.warn(`[fleet-listener] ignoring invalid KANBAN_FLEET_PORT=${raw}; the fleet listener stays disabled`);
    return null;
  }
  return parsed;
}

export async function startFleetListener(opts: {
  database: Database;
  port: number;
  createWorkersRoute: CreateWorkersRoute;
  /** Defaults to all interfaces — the whole point of this listener. */
  host?: string;
}): Promise<FleetListenerHandle> {
  const { database, port, createWorkersRoute, host = "0.0.0.0" } = opts;
  const fleet = getWorkerFleet(database);

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // Both paths: the main board serves /api/health, so accepting either here
  // means one reachability instruction works against either port.
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/api/workers", createWorkersRoute(database, fleet.registry));
  app.get("/ws/workers/:id", createWorkerWsRoute(upgradeWebSocket, fleet.registry, fleet.connections));

  const listening = await new Promise<{ port: number; server: ReturnType<typeof serve> }>((resolve, reject) => {
    try {
      const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
        resolve({ port: info.port, server });
      });
      server.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
  injectWebSocket(listening.server);

  console.log(
    `[fleet-listener] worker endpoints exposed on ${host}:${listening.port} ` +
      "(register/heartbeat/ws only — the board API stays on loopback)",
  );

  return {
    port: listening.port,
    close: () => new Promise<void>((resolve) => listening.server.close(() => resolve())),
  };
}
