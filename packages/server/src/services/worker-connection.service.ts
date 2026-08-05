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
  /**
   * Sessions ASSIGNED to this worker that have not reported anything yet
   * (sessionId -> expiry epoch ms). Board-side load used to be derived purely
   * from worker events, so an `assign` counted as zero until the agent's first
   * byte of output — and a monitor cycle could hand three sessions to a
   * maxConcurrency=1 worker, all three reading load 0 (#248). Entries expire so a
   * dispatch that vanished without a trace cannot pin capacity forever.
   */
  pendingSessionIds: Map<string, number>;
}

/**
 * How long an assigned-but-silent session counts against a worker's capacity.
 * Long enough to cover a git-transport clone + setup script before the agent's
 * first output; short enough that a lost assignment frees the slot on its own.
 */
export const PENDING_ASSIGN_TTL_MS = 10 * 60 * 1000;

export function createWorkerConnectionManager(registry: WorkerRegistry) {
  const connections = new Map<string, WorkerConnection>();
  const listeners = new Set<WorkerMessageListener>();
  const connectListeners = new Set<(workerId: string) => void>();
  const disconnectListeners = new Set<(workerId: string) => void>();
  // A revoked worker's bearer token stops authenticating NEW requests, but an
  // already-upgraded socket is never re-checked — so revocation has to reach in
  // and close it. Wired here (the manager already owns the registry) so every
  // manager built on a registry honours it, not just the fleet facade's.
  registry.onRevoke((workerId) => { closeConnection(workerId); });

  function handleOpen(workerId: string, ws: WSContext): void {
    // A reconnect replaces the previous socket (stale after e.g. a NAT rebind).
    const existing = connections.get(workerId);
    if (existing) {
      try { existing.ws.close(); } catch { /* already gone */ }
    }
    connections.set(workerId, { ws, runningSessionIds: new Set(), pendingSessionIds: new Map() });
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
        // The worker just declared what it actually holds — that supersedes every
        // board-side guess, so the pending set is reconciled away entirely.
        conn.runningSessionIds = new Set(message.runningSessionIds);
        conn.pendingSessionIds.clear();
      } else if (message.type === "event") {
        conn.pendingSessionIds.delete(message.event.sessionId);
        if (message.event.type === "exit") conn.runningSessionIds.delete(message.event.sessionId);
        else conn.runningSessionIds.add(message.event.sessionId);
      } else if (message.type === "assign_failed") {
        conn.pendingSessionIds.delete(message.sessionId);
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
  function send(workerId: string, message: BoardToWorkerMessage, now = Date.now()): boolean {
    const conn = connections.get(workerId);
    if (!conn) return false;
    try {
      conn.ws.send(JSON.stringify(message));
      // A delivered `assign` occupies a slot from THIS moment, not from the
      // agent's first output (#248).
      if (message.type === "assign") {
        conn.pendingSessionIds.set(message.sessionId, now + PENDING_ASSIGN_TTL_MS);
      }
      return true;
    } catch (err) {
      console.error(`[worker-connection] send failed: workerId=${workerId}`, err);
      return false;
    }
  }

  function isConnected(workerId: string): boolean {
    return connections.has(workerId);
  }

  /**
   * Drop a worker's live socket immediately. Used when a worker is REVOKED: its
   * bearer token stops authenticating new requests, but an already-upgraded
   * socket was never checked again, so a revoked worker kept streaming events
   * into in-flight sessions (and kept receiving assignments) until it happened
   * to disconnect. Closing here makes revocation take effect at once.
   */
  function closeConnection(workerId: string): boolean {
    const conn = connections.get(workerId);
    if (!conn) return false;
    connections.delete(workerId);
    try { conn.ws.close(); } catch { /* already gone */ }
    console.log(`[worker-connection] closed socket for revoked worker: id=${workerId}`);
    for (const listener of disconnectListeners) {
      try { listener(workerId); } catch (err) { console.error(`[worker-connection] disconnect-listener error`, err); }
    }
    return true;
  }

  function connectedWorkerIds(): string[] {
    return [...connections.keys()];
  }

  function runningSessionIds(workerId: string): string[] {
    return [...(connections.get(workerId)?.runningSessionIds ?? [])];
  }

  /**
   * Every session this worker owes the board an answer for: the ones it has
   * reported PLUS the ones dispatched to it that have not spoken yet. This — not
   * `runningSessionIds` — is the worker's load for capacity decisions (#248).
   */
  function assignedSessionIds(workerId: string, now = Date.now()): string[] {
    const conn = connections.get(workerId);
    if (!conn) return [];
    for (const [sessionId, expiresAt] of conn.pendingSessionIds) {
      if (expiresAt <= now) conn.pendingSessionIds.delete(sessionId);
    }
    return [...new Set([...conn.runningSessionIds, ...conn.pendingSessionIds.keys()])];
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
    closeConnection,
    connectedWorkerIds,
    runningSessionIds,
    assignedSessionIds,
    onMessage,
    onConnect,
    onDisconnect,
  };
}

export type WorkerConnectionManager = ReturnType<typeof createWorkerConnectionManager>;

/**
 * Bearer token from the Authorization HEADER only. There used to be a
 * `?token=<worker-token>` fallback "for WS clients that cannot set headers" —
 * but the only client is the bundled daemon, which always sends the header, and
 * a token in a query string is written verbatim into proxy and access logs. The
 * fallback bought nothing and leaked the credential, so it is gone.
 */
function extractToken(c: Context): string | null {
  const header = c.req.header("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]! : null;
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
