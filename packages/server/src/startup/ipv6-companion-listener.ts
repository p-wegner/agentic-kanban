import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import type { createNodeWebSocket } from "@hono/node-ws";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export interface Ipv6CompanionServer {
  close: (cb?: () => void) => void;
}

/**
 * Also listens on the IPv6 loopback, extracted from `server-start.ts` (#873).
 *
 * #343 — so `http://localhost:PORT` stops paying a flat ~206ms tax on every
 * single request.
 *
 * Measured on this box: time_connect via `localhost` is 0.204-0.216s, via
 * `127.0.0.1` it is 0.0009s. Windows resolves `localhost` to `::1` FIRST;
 * with only 127.0.0.1 bound, every client attempts the IPv6 connect, waits
 * for it to fail, and falls back to IPv4. That is a hard floor under
 * `time_total`, not server time.
 *
 * It matters because essentially everything the board GENERATES tells agents
 * to use `localhost:3001` — worktree ticket-context files, CLAUDE.md, the
 * board-navigator skill, MCP notifyBoard, the docs — so every agent curl and
 * every board-notify pays it, often many times per task.
 *
 * Deliberately `::1` and NOT `::`: the board API has no auth, so the
 * loopback-only posture is a security invariant (see the fleet-port note in
 * CLAUDE.md). `::1` is loopback, so the posture is unchanged. Only added
 * when the primary listener is itself the IPv4 loopback default — an
 * operator who set KANBAN_HOST to something else has chosen their own
 * binding and we must not widen it. Failure to bind is NON-FATAL: the IPv4
 * listener is the one of record and the fallback path still works, just
 * slowly.
 */
export function maybeStartIpv6CompanionListener(
  app: Hono,
  serverHost: string,
  serverPort: number,
  usesTls: boolean,
  injectWebSocket: ReturnType<typeof createNodeWebSocket>["injectWebSocket"],
): Ipv6CompanionServer | null {
  if (usesTls || (serverHost !== "127.0.0.1" && serverHost !== "localhost")) return null;

  try {
    const companion = serve({ fetch: app.fetch, port: serverPort, hostname: "::1" }, () => {
      console.log(`Server also running at http://[::1]:${serverPort} (removes the ~206ms IPv6-fallback tax on \`localhost\`)`);
    });
    (companion as { keepAliveTimeout?: number }).keepAliveTimeout = 1000;
    // Same fetch handler, so WS upgrades must work on this listener too — a browser
    // resolving `localhost` to ::1 would otherwise get a dead board socket.
    injectWebSocket(companion);
    companion.on("error", (err: Error) => {
      console.warn(`[ipv6] loopback listener error (non-fatal, IPv4 still serving): ${err.message}`);
    });
    return companion;
  } catch (err) {
    console.warn(`[ipv6] could not bind [::1]:${serverPort} (non-fatal, IPv4 still serving): ${errorMessage(err)}`);
    return null;
  }
}
