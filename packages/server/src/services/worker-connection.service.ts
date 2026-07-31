// Board-side fleet connections (epic #1, phase 1b #4).
//
// One WebSocket per connected worker, upgraded at GET /ws/workers/:id after a
// bearer-token check against the worker registry. The manager tracks live
// connections, fans worker messages out to listeners (the remote execution
// service subscribes in phase 1c), and touches the worker's heartbeat on every
// message so a chatty worker never reads stale. Connection state is in-memory
// by design — a board restart drops sockets and workers reconnect, announcing
// their still-running sessions in a fresh `hello`.

import type { Context, Next } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import {
  parseWorkerToBoardMessage,
  type BoardToWorkerMessage,
  type WorkerToBoardMessage,
} from "@agentic-kanban/shared/lib/worker-protocol";
import type { WorkerRegistry } from "./worker-registry.service.js";

export type WorkerMessageListener = (workerId: string, message: WorkerToBoardMessage) => void;

interface WorkerConnection {
  ws: WSContext;
  runningSessionIds: Set<string>;
}

export function createWorkerConnectionManager(registry: WorkerRegistry) {
  const connections = new Map<string, WorkerConnection>();
  const listeners = new Set<WorkerMessageListener>();
  const connectListeners = new Set<(workerId: string) => void>();
  const disconnectListeners = new Set<(workerId: string) => void>();

  function handleOpen(workerId: string, ws: WSContext): void {
    // A reconnect replaces the previous socket (stale after e.g. a NAT rebind).
    const existing = connections.get(workerId);
    if (existing) {
      try { existing.ws.close(); } catch { /* already gone */ }
    }
    connections.set(workerId, { ws, runningSessionIds: new Set() });
    console.log(`[worker-connection] worker connected: id=${workerId}`);
    for (const listener of connectListeners) {
      try { listener(workerId); } catch (err) { console.error(`[worker-connection] connect-listener error`, err); }
    }
  }

  function handleMessage(workerId: string, raw: unknown): void {
    const message = parseWorkerToBoardMessage(raw);
    if (!message) {
      console.warn(`[worker-connection] dropping malformed message from worker ${workerId}`);
      return;
    }
    const conn = connections.get(workerId);
    if (conn) {
      if (message.type === "hello") {
        conn.runningSessionIds = new Set(message.runningSessionIds);
      } else if (message.type === "event") {
        if (message.event.type === "exit") conn.runningSessionIds.delete(message.event.sessionId);
        else conn.runningSessionIds.add(message.event.sessionId);
      }
    }
    // Any authenticated traffic proves liveness — keep the registry heartbeat fresh.
    void registry.touchHeartbeat(workerId).catch(() => {});
    for (const listener of listeners) {
      try {
        listener(workerId, message);
      } catch (err) {
        console.error(`[worker-connection] listener error: workerId=${workerId}`, err);
      }
    }
  }

  function handleClose(workerId: string, ws: WSContext): void {
    // Only forget the mapping if it still points at THIS socket — a reconnect
    // may already have replaced it.
    if (connections.get(workerId)?.ws === ws) {
      connections.delete(workerId);
      console.log(`[worker-connection] worker disconnected: id=${workerId}`);
      for (const listener of disconnectListeners) {
        try { listener(workerId); } catch (err) { console.error(`[worker-connection] disconnect-listener error`, err); }
      }
    }
  }

  /** Send a board→worker message. False when the worker is not connected. */
  function send(workerId: string, message: BoardToWorkerMessage): boolean {
    const conn = connections.get(workerId);
    if (!conn) return false;
    try {
      conn.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      console.error(`[worker-connection] send failed: workerId=${workerId}`, err);
      return false;
    }
  }

  function isConnected(workerId: string): boolean {
    return connections.has(workerId);
  }

  function connectedWorkerIds(): string[] {
    return [...connections.keys()];
  }

  function runningSessionIds(workerId: string): string[] {
    return [...(connections.get(workerId)?.runningSessionIds ?? [])];
  }

  /** Subscribe to all worker messages; returns an unsubscribe. */
  function onMessage(listener: WorkerMessageListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function onConnect(listener: (workerId: string) => void): () => void {
    connectListeners.add(listener);
    return () => connectListeners.delete(listener);
  }

  function onDisconnect(listener: (workerId: string) => void): () => void {
    disconnectListeners.add(listener);
    return () => disconnectListeners.delete(listener);
  }

  return {
    handleOpen,
    handleMessage,
    handleClose,
    send,
    isConnected,
    connectedWorkerIds,
    runningSessionIds,
    onMessage,
    onConnect,
    onDisconnect,
  };
}

export type WorkerConnectionManager = ReturnType<typeof createWorkerConnectionManager>;

function extractToken(c: Context): string | null {
  const header = c.req.header("authorization");
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1]!;
  }
  // Fallback for WS clients that cannot set headers (browser-style APIs).
  const query = c.req.query("token");
  return query || null;
}

/**
 * GET /ws/workers/:id — token-authed WebSocket upgrade for a fleet worker.
 * Auth happens BEFORE the upgrade; an unauthenticated caller gets 401, never
 * a socket.
 */
export function createWorkerWsRoute(
  upgradeWebSocket: UpgradeWebSocket,
  registry: WorkerRegistry,
  manager: WorkerConnectionManager,
) {
  const upgrade = upgradeWebSocket((c: Context) => {
    const workerId = c.req.param("id")!;
    return {
      onOpen(_event: Event, ws: WSContext) {
        manager.handleOpen(workerId, ws);
      },
      onMessage(event: MessageEvent, _ws: WSContext) {
        manager.handleMessage(workerId, typeof event.data === "string" ? event.data : String(event.data));
      },
      onClose(_event: CloseEvent, ws: WSContext) {
        manager.handleClose(workerId, ws);
      },
    };
  });
  return async (c: Context, next: Next) => {
    const workerId = c.req.param("id")!;
    const token = extractToken(c);
    if (!token || !(await registry.authenticateWorker(workerId, token))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return upgrade(c, next);
  };
}
