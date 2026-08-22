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
import { envPort, resolveListenHost } from "../lib/bearer-token.js";

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
  // Fallback null = disabled, deliberately unlike git-http's 0 = OS-assigned: a
  // single-machine board must not open a network port just by existing (#556).
  return envPort("KANBAN_FLEET_PORT", {
    fallback: null,
    logPrefix: "[fleet-listener]",
    onInvalid: "the fleet listener stays disabled",
  }, env);
}

/**
 * Which interface the fleet listener binds, from `KANBAN_FLEET_HOST` (#652, #753).
 *
 * The reason to narrow it is a VPN posture: on a tailnet the intended exposure is "the
 * tailnet address only", and without it the operator who opens a fleet port also
 * publishes it on the office LAN, the home LAN and hotel wifi. Both listeners
 * bearer-authenticate every request, so this is defence in depth — but the design
 * principle of the second listener is to expose the minimum DELIBERATELY, and the
 * interface is part of that minimum.
 *
 * #753 turned that principle into the DEFAULT. Absent used to mean `0.0.0.0`, so pinning
 * a fleet port silently published a plaintext credential-bearing channel on every
 * interface; absent now means loopback, and every-interface has to be asked for by name
 * (`KANBAN_FLEET_INSECURE=1`). Shares its policy with the git transport via
 * `resolveListenHost` so the two cannot drift on what "unset" means.
 *
 * A blank/whitespace value falls back rather than binding to nothing. There is no
 * syntax check beyond that: an unresolvable host surfaces as a bind error at startup,
 * which is already handled (non-fatal, named in the log), and a hostname allowlist here
 * would only reject valid inputs the OS accepts.
 */
export function resolveFleetHost(env: NodeJS.ProcessEnv = process.env): string {
  return resolveListenHost({
    raw: env.KANBAN_FLEET_HOST,
    insecure: env.KANBAN_FLEET_INSECURE,
    logPrefix: "[fleet-listener]",
  });
}

export async function startFleetListener(opts: {
  database: Database;
  port: number;
  createWorkersRoute: CreateWorkersRoute;
  /** Defaults to `resolveFleetHost()` — loopback unless an interface is named (#753). */
  host?: string;
}): Promise<FleetListenerHandle> {
  const { database, port, createWorkersRoute, host = resolveFleetHost() } = opts;
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
      reject(err instanceof Error ? err : new Error(String(err)));
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
