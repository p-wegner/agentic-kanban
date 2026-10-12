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
//   POST /api/workers/register           (pairing token -> per-worker token)
//   POST /api/workers/:id/heartbeat      (per-worker bearer token)
//   GET  /api/workers/:id/update-check   (per-worker bearer token — the board's build, #880)
//   GET  /ws/workers/:id                 (per-worker bearer token, checked pre-upgrade)
//   ALL  /mcp                         (per-ASSIGNMENT token, allowlisted board tools — #769)
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
import { resolveConfiguredFleetPort, resolveListenHost } from "../lib/bearer-token.js";
import { resolveBindHosts, warnOnNonTailnetBinds } from "../lib/listen-hosts.js";
import { FLEET_MCP_PATH, getFleetMcpBridge } from "./fleet-mcp-bridge.service.js";
import { getOrCreateServiceStackInstanceId } from "../repositories/workspace-service-state.repository.js";
import type { Context } from "hono";

/** `{ boardId }` for the health/register answers; empty when the id cannot be read (never fails a probe). */
export async function boardIdentityField(database: Database): Promise<{ boardId?: string }> {
  try {
    return { boardId: await getOrCreateServiceStackInstanceId(database) };
  } catch {
    return {};
  }
}

/**
 * Factory for the owner+worker-facing `/api/workers` router. Injected by the
 * caller (server-start.ts) instead of imported directly — services must not
 * depend on the transport layer (routes/), so this stays a parameter, not an
 * import, per the routes<-services layering rule.
 */
export type CreateWorkersRoute = (database: Database, registry: WorkerRegistry) => Hono;

export interface FleetListenerHandle {
  port: number;
  /** The bound addresses, comma-joined (one entry unless a list was configured, #1337). */
  host: string;
  hosts: string[];
  close(): Promise<void>;
}

/**
 * Resolve the configured fleet port. Absent/empty = disabled (the default: a
 * single-machine board must not open a network port just by existing). Invalid
 * values warn and disable rather than crashing the board on a typo.
 */
export function resolveFleetPort(env: NodeJS.ProcessEnv = process.env): number | null {
  // Delegated to the shared primitive (#776): the git transport now needs the SAME answer
  // to decide whether an OS-assigned git port is acceptable, and two hand-copied parses of
  // one variable is the drift #556 removed. This stays the exported name because "the fleet
  // port" is this module's concept; only the parse moved.
  return resolveConfiguredFleetPort(env);
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
  const { database, port, createWorkersRoute } = opts;
  // #1325: `KANBAN_FLEET_HOST=tailscale` is resolved HERE, at bind time, and throws when the
  // address is unavailable — the supervisor's retry loop turns that into "not up yet".
  // #1337: the value may be a comma-separated list; every entry is bound.
  const hosts = resolveBindHosts(opts.host ?? resolveFleetHost());
  const fleet = getWorkerFleet(database);
  const mcp = getFleetMcpBridge(database);

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // Both paths: the main board serves /api/health, so accepting either here
  // means one reachability instruction works against either port.
  // #1337: the board's stable identity rides the unauthenticated health answer too, so a worker
  // holding several URLs can tell they are one board BEFORE it pairs (it is an opaque random id).
  const health = async (c: Context) => c.json({ ok: true, ...(await boardIdentityField(database)) });
  app.get("/health", health);
  app.get("/api/health", health);
  app.route("/api/workers", createWorkersRoute(database, fleet.registry));
  // #769: the authority the worker DIALED, learned from its own request rather than guessed by
  // the board. `Host` on the websocket upgrade is exactly the `--board` host:port the worker was
  // started with, which is what makes the MCP bridge URL composable without the board ever
  // knowing its own external hostname (see `composeFleetMcpUrl`). Registered before the route so
  // it runs on the upgrade request itself.
  app.use("/ws/workers/:id", async (c, next) => {
    mcp.noteWorkerBoardHost(c.req.param("id"), c.req.header("host"));
    await next();
  });
  app.get("/ws/workers/:id", createWorkerWsRoute(upgradeWebSocket, fleet.registry, fleet.connections));
  // The board's TOOL surface, narrowed to an allowlist and scoped to one assignment (#769). It
  // belongs here and nowhere else: this is the only listener that authenticates every request,
  // and the board API port must stay loopback-only and unauthenticated.
  app.route(FLEET_MCP_PATH, mcp.route());

  // #1337: one server per listed address, all on the same port. All-or-nothing: if any address
  // fails to bind the ones already open are closed and the error propagates, so the supervisor
  // retries the whole set (never a half-exposed listener that nothing retries).
  const servers: ReturnType<typeof serve>[] = [];
  let boundPort = port;
  try {
    for (const hostname of hosts) {
      const listening = await new Promise<{ port: number; server: ReturnType<typeof serve> }>((resolve, reject) => {
        try {
          const server = serve({ fetch: app.fetch, port: boundPort, hostname }, (info) => {
            resolve({ port: info.port, server });
          });
          server.on("error", reject);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      servers.push(listening.server);
      injectWebSocket(listening.server);
      boundPort = listening.port;
    }
  } catch (err) {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    throw err;
  }
  // The ACTUAL bound port (which differs from `port` when 0 was requested). The dispatch path
  // refuses to offer board tools until this is known, so a board with no fleet listener in this
  // process still ships the honest "no board tools" brief (#769).
  mcp.setEndpointPort(boundPort);
  warnOnNonTailnetBinds("[fleet-listener]", hosts);

  console.log(
    `[fleet-listener] worker endpoints exposed on ${hosts.map((h) => `${h}:${boundPort}`).join(", ")} ` +
      `(register/heartbeat/ws + allowlisted board MCP at ${FLEET_MCP_PATH} — the board API stays on loopback)`,
  );

  return {
    port: boundPort,
    host: hosts.join(","),
    hosts,
    close: async () => {
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
      mcp.setEndpointPort(null);
    },
  };
}
