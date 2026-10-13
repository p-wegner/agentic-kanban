import type { Context, Next } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import type { WorkerServicesClient } from "../services/worker-services-client.js";
import { createRouter } from "../middleware/create-router.js";
import { findRemoteServiceByPort } from "../services/workspace-remote-placement.js";

/**
 * The board's door to a worker-side dev server or compose port (#1447, part b of #1432):
 * `/api/workspaces/:id/proxy/<port>/...`, HTTP and WebSocket, tunnelled over the existing fleet
 * connection. Nothing listens on the LAN — the worker only ever dials its own 127.0.0.1, and only
 * for a port a service of THIS workspace registered, so this is not a general loopback relay.
 *
 * Registered with `all` + an `Upgrade` check rather than `get/post/...` because it is one wildcard
 * door for every method and the WebSocket upgrade, which OpenAPI cannot express as a path (`*`);
 * the dev-server routes that return its URL are documented in `workspace-dev-server.ts`.
 *
 * The app is reached UNDER a path prefix, so one that links to `/assets/x.js` needs a base path
 * configured (`X-Forwarded-Prefix` carries the prefix for apps that honour it).
 */
export function createWorkspaceProxyRoute(upgradeWebSocket: UpgradeWebSocket) {
  const router = createRouter();

  /** Resolve `:id/:port` to the worker holding that registered port, or the reason it cannot be reached. */
  function resolveTarget(c: Context): { client: WorkerServicesClient; workerId: string; port: number; workspaceId: string; path: string; prefix: string } | Response {
    const workspaceId = c.req.param("id")!;
    const port = Number(c.req.param("port"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return c.json({ error: "invalid port" }, 400);
    const found = findRemoteServiceByPort(workspaceId, port);
    if (!found) return c.json({ error: `no worker-side service of this workspace has registered port ${port}` }, 404);
    const rec = found.record;
    if (rec.status === "unreachable") return c.json({ error: `fleet worker ${rec.workerId} is unreachable — the service cannot be reached until it reconnects` }, 502);
    const url = new URL(c.req.url);
    const prefix = `/api/workspaces/${encodeURIComponent(workspaceId)}/proxy/${port}`;
    const at = url.pathname.indexOf(`/proxy/${port}`);
    const rest = at >= 0 ? url.pathname.slice(at + `/proxy/${port}`.length) : "";
    return { client: found.client, workerId: rec.workerId, port, workspaceId, path: `${rest || "/"}${url.search}`, prefix };
  }

  const upgrade = upgradeWebSocket((c: Context) => {
    const target = resolveTarget(c);
    let socket: { send: (data: Buffer, binary: boolean) => void; close: (code?: number, reason?: string) => void } | null = null;
    let closed = false;
    const queued: Array<{ data: Buffer; binary: boolean }> = [];
    return {
      async onOpen(_event: Event, ws: WSContext) {
        if (target instanceof Response) { ws.close(1008, "no such service"); return; }
        const client = target.client;
        const headers = Object.fromEntries([...c.req.raw.headers.entries()].filter(([k]) => !/^(sec-websocket-|upgrade$|connection$)/i.test(k)));
        const opened = await client.openProxySocket(target.workerId, { workspaceId: target.workspaceId, port: target.port, path: target.path, headers }, {
          onData: (data, binary) => { try { ws.send(binary ? new Uint8Array(data) : data.toString("utf8")); } catch { /* client gone */ } },
          onClose: (code, reason) => { closed = true; try { ws.close(code && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, reason); } catch { /* gone */ } },
        });
        if (!opened.ok) { closed = true; ws.close(1011, opened.error.slice(0, 120)); return; }
        socket = opened.socket;
        for (const q of queued.splice(0)) socket.send(q.data, q.binary);
        if (closed) socket.close();
      },
      onMessage(event: MessageEvent) {
        const binary = typeof event.data !== "string";
        const data = typeof event.data === "string" ? Buffer.from(event.data, "utf8") : Buffer.from(event.data as ArrayBuffer);
        if (socket) socket.send(data, binary);
        else queued.push({ data, binary });
      },
      onClose() { closed = true; socket?.close(); },
    };
  });

  async function handler(c: Context, next: Next) {
    const target = resolveTarget(c);
    if (target instanceof Response) return target;
    if (c.req.header("upgrade")?.toLowerCase() === "websocket") return upgrade(c as Parameters<typeof upgrade>[0], next);

    const client = target.client;
    const method = c.req.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? Buffer.from(await c.req.arrayBuffer()) : null;
    const headers = Object.fromEntries([...c.req.raw.headers.entries()]);
    const result = await client.proxyHttp(target.workerId, {
      workspaceId: target.workspaceId, port: target.port, method, path: target.path,
      headers: { ...headers, "x-forwarded-prefix": target.prefix },
      ...(body && body.length > 0 ? { bodyB64: body.toString("base64") } : {}),
    });
    if (result.error && result.status >= 500 && !result.bodyB64) return c.json({ error: result.error }, 502);
    const out = new Headers();
    for (const [k, v] of Object.entries(result.headers)) {
      if (k.toLowerCase() === "set-cookie") for (const cookie of v.split("\n")) out.append("set-cookie", cookie);
      else out.set(k, v);
    }
    const noBody = [101, 204, 205, 304].includes(result.status) || method === "HEAD";
    return new Response(noBody ? null : new Uint8Array(Buffer.from(result.bodyB64 ?? "", "base64")), { status: result.status, headers: out });
  }

  router.all("/:id/proxy/:port", handler);
  router.all("/:id/proxy/:port/*", handler);
  return router;
}
