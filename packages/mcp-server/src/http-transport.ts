import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * HTTP transport for the board MCP server (#136).
 *
 * WHY THIS EXISTS. A containerized builder gets an MCP config describing a STDIO
 * server launched from the board's host checkout — paths that do not exist inside
 * the container. Bind-mounting the board repo does not fix it either: the MCP
 * server opens the database through better-sqlite3, a natively-compiled Windows
 * binary that cannot load under Linux. So the server has to be reachable over the
 * network instead of spawned as a child, and the container dials the host at
 * `host.docker.internal`.
 *
 * SECURITY. This endpoint exposes the FULL board tool surface — including
 * `delete_issue`, `merge_workspace` and `start_workspace`. It cannot bind to
 * loopback, because `host.docker.internal` resolves to the host's gateway address,
 * not 127.0.0.1, so a loopback-only listener is unreachable from the container.
 * Being reachable off-loopback, it therefore REQUIRES a bearer token:
 *
 *  - the token is generated per board start and handed only to containers the
 *    board itself provisions, via a config file on an already-private mount;
 *  - every request is checked before it reaches the MCP layer, with a
 *    length-safe constant-time comparison so the token cannot be recovered by
 *    timing;
 *  - a missing or wrong token gets 401 and never touches a tool.
 *
 * Do NOT add an "allow unauthenticated on localhost" shortcut: the whole point is
 * that the traffic arrives from off-host as far as the kernel is concerned, so
 * such a check would either reject the container or accept the network.
 */

/**
 * Stateless: `sessionIdGenerator: undefined` means no session affinity, and each
 * request gets a FRESH server+transport pair that is closed when it completes.
 *
 * Per request rather than one shared pair, because `McpServer` and a transport are
 * 1:1. Sharing one connected transport across requests looked fine for a bare
 * `tools/list` but broke a real client: `initialize` succeeded and the follow-up
 * `notifications/initialized` POST returned 500, so the Claude CLI reported
 * `mcp_servers: [{"name":"agentic-kanban","status":"failed"}]` — the same
 * no-board-tools symptom #136 was filed for, just with a different cause. Building
 * the pair per request is cheap (tool registration is closure creation) and needs no
 * session map, so there is nothing to leak or expire.
 */
const SESSION_ID_GENERATOR = undefined;

export interface McpHttpServerHandle {
  port: number;
  close: () => Promise<void>;
}

/** Constant-time compare that does not leak length via an early return. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so a length mismatch is not measurably faster.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function extractBearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || Array.isArray(header)) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

function reject(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

/**
 * Serve `server` over Streamable HTTP on `port`, requiring `token` on every request.
 *
 * `port: 0` asks the OS for a free port and the real one comes back on the handle —
 * always prefer that over guessing, since guessing a port in 30000-60000 on Windows
 * flakes with EACCES against reserved ranges.
 */
export async function startMcpHttpServer(opts: {
  /** Builds a fresh, fully-registered server for each request (see SESSION_ID_GENERATOR). */
  createServer: () => McpServer;
  token: string;
  port?: number;
  /** Defaults to all interfaces, which is REQUIRED for host.docker.internal. */
  host?: string;
}): Promise<McpHttpServerHandle> {
  const { createServer: createMcpServer, token, port = 0, host = "0.0.0.0" } = opts;

  const http = createServer((req, res) => {
    void (async () => {
      try {
        if (req.url && req.url.replace(/\/+$/, "") === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        const provided = extractBearer(req);
        if (!provided || !tokensMatch(provided, token)) {
          reject(res, 401, "unauthorized");
          return;
        }

        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: SESSION_ID_GENERATOR,
          enableJsonResponse: true,
        });
        // Close the pair once the response is done, whether it finished or the
        // client hung up — otherwise every request leaks a server + transport.
        res.once("close", () => {
          void transport.close().catch(() => {});
          void server.close().catch(() => {});
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        // Never let a request kill the listener — mirrors the stdio path's
        // resilience, where a crash makes every board op fail with
        // `server "agentic-kanban" is not connected`.
        console.error("[mcp-http] request failed:", err);
        if (!res.headersSent) reject(res, 500, "internal error");
      }
    })();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    http.once("error", rejectListen);
    http.listen(port, host, () => {
      http.removeListener("error", rejectListen);
      resolveListen();
    });
  });

  const address = http.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolveClose) => {
        http.close(() => resolveClose());
      }),
  };
}
