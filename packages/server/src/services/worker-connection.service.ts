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
import { extractBearer } from "../lib/bearer-token.js";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import {
  parseWorkerToBoardMessage,
  type BoardToWorkerMessage,
  type WorkerToBoardMessage,
} from "@agentic-kanban/shared/lib/worker-protocol";
import type { WorkerRegistry } from "./worker-registry.service.js";
import type { DeferredLaunchFailure } from "./agent-dispatch.service.js";

/**
 * What KIND of launch failure a worker's `assign_failed` reports (#751).
 *
 * The board used to turn every `assign_failed` into a synthesized `exit 1` on the
 * session, which erases the one distinction an operator needs: "no worker took this"
 * looks identical to "a worker took it and the launch died on that machine". They
 * need different responses — a capacity refusal means ANOTHER worker would have
 * succeeded, a provisioning failure means that worker's checkout is broken.
 *
 * Matching on the worker's own message is a heuristic, not a protocol: the daemon
 * sends free text. It narrows the gap rather than closing it, and `unknown` is an
 * honest answer, not a fallback that pretends to know.
 */
export function classifyAssignFailure(error: string): DeferredLaunchFailure["kind"] {
  const text = error.toLowerCase();
  if (/\bcapacity\b|max ?concurrency|too many|at capacity/.test(text)) return "capacity";
  if (/clone|checkout|worktree|provision|setup|lock ref|fetch|lfs|submodule/.test(text)) return "provisioning";
  return "dispatch";
}

export type WorkerMessageListener = (workerId: string, message: WorkerToBoardMessage) => void;

interface WorkerConnection {
  ws: WSContext;
  runningSessionIds: Set<string>;
  /**
   * When each running session last said anything (sessionId -> epoch ms).
   *
   * The running half of a worker's load used to have no liveness bound at all: a
   * session entered it on its first event and left it ONLY on an `exit` frame. So an
   * agent that spoke once and then hung — zombied, or never reaped by the worker —
   * kept occupying a slot for the whole life of that socket, and on a
   * `maxConcurrency: 4` worker four of them made the worker permanently ineligible
   * (#883). A `hello` cures it, but only on reconnect; nothing bounded it in between.
   *
   * This is the same reasoning #248 already applied to `pendingSessionIds` — it was
   * simply never carried across to the set beside it.
   */
  lastEventAt: Map<string, number>;
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

/**
 * How long a RUNNING session may be silent before it stops counting against its
 * worker's capacity (#883).
 *
 * Deliberately far longer than `PENDING_ASSIGN_TTL_MS`, and the asymmetry is the
 * point. A pending session has produced nothing, so expiring one early costs a
 * re-dispatch. A running session is a live agent that may legitimately say nothing
 * for a long stretch — a cold dependency install, a full test suite, a long think —
 * and evicting a LIVE session from the count causes OVER-dispatch, which is strictly
 * worse than the under-dispatch this bound exists to fix. Two hours is chosen to sit
 * above any plausible legitimate silence rather than to detect a zombie quickly:
 * this is a backstop, not a health check.
 */
export const RUNNING_SESSION_SILENCE_TTL_MS = 2 * 60 * 60 * 1000;

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
    //
    // Say so in the log. This eviction is indistinguishable from a network drop
    // at the worker end — a daemon sees only a close — so a silent eviction plus
    // a reconnecting daemon is a self-sustaining flap that reads as "the network
    // is bad" on both sides. It cost a cross-machine bring-up an afternoon: 6
    // connects and 13 disconnects, each landing ~1s after a SUCCESSFUL connect,
    // while HTTP to the same port was 200 throughout. The revoke path already
    // logs (see closeConnection); this one is the gap.
    const existing = connections.get(workerId);
    if (existing) {
      console.log(
        `[worker-connection] evicting previous socket for id=${workerId} — a newer connection arrived. ` +
          `If this repeats, the worker is opening overlapping sockets (reconnect firing while a connect is in flight), not losing the network.`,
      );
      try { existing.ws.close(); } catch { /* already gone */ }
    }
    connections.set(workerId, {
      ws,
      runningSessionIds: new Set(),
      lastEventAt: new Map(),
      pendingSessionIds: new Map(),
    });
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
        // The declaration is itself the freshest thing we know about each of them,
        // so the silence clock restarts here — otherwise a reconnect would inherit
        // an already-expired stamp and evict a session the worker just vouched for.
        const declaredAt = Date.now();
        conn.lastEventAt = new Map(message.runningSessionIds.map((id) => [id, declaredAt]));
      } else if (message.type === "event") {
        conn.pendingSessionIds.delete(message.event.sessionId);
        if (message.event.type === "exit") {
          conn.runningSessionIds.delete(message.event.sessionId);
          conn.lastEventAt.delete(message.event.sessionId);
        } else {
          conn.runningSessionIds.add(message.event.sessionId);
          conn.lastEventAt.set(message.event.sessionId, Date.now());
        }
      } else if (message.type === "assign_failed") {
        conn.pendingSessionIds.delete(message.sessionId);
        // Say what KIND of failure this is on the line an operator actually reads
        // (#751). A bare "assign failed" plus a synthesized exit 1 downstream is
        // indistinguishable from an agent that ran and returned 1.
        console.warn(
          `[worker-connection] assign_failed kind=${classifyAssignFailure(message.error)} ` +
            `worker=${workerId} session=${message.sessionId}: ${message.error}`,
        );
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
   * Drop a worker's live socket immediately.
   *
   * Originally for REVOCATION: a revoked worker's bearer token stops authenticating new
   * requests, but an already-upgraded socket was never checked again, so it kept
   * streaming events into in-flight sessions (and kept receiving assignments) until it
   * happened to disconnect. Closing here makes revocation take effect at once.
   *
   * The stale-connection reaper (#706) closes sockets for a SECOND reason — a worker
   * that went silent without ever delivering a close. Hence `reason`: without it every
   * reap logged "revoked worker" for a peer nobody revoked, which is exactly the kind
   * of confidently-wrong log line that sends the next reader after the wrong bug.
   */
  function closeConnection(workerId: string, reason = "revoked"): boolean {
    const conn = connections.get(workerId);
    if (!conn) return false;
    connections.delete(workerId);
    try { conn.ws.close(); } catch { /* already gone */ }
    console.log(`[worker-connection] closed socket: id=${workerId} reason=${reason}`);
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
    // A running session that has said nothing for RUNNING_SESSION_SILENCE_TTL_MS stops
    // counting (#883). It is NOT removed from `runningSessionIds`: that set is the
    // worker's own declaration of what it holds, and the board is in no position to
    // contradict it — this only says the board will no longer let it pin capacity.
    const silent: string[] = [];
    for (const sessionId of conn.runningSessionIds) {
      const lastSeen = conn.lastEventAt.get(sessionId);
      if (lastSeen !== undefined && now - lastSeen >= RUNNING_SESSION_SILENCE_TTL_MS) {
        silent.push(sessionId);
      }
    }
    if (silent.length > 0) {
      console.warn(
        `[worker-connection] not counting ${silent.length} silent session(s) against worker=${workerId} capacity: ` +
          `${silent.join(", ")} — each has been quiet for over ${Math.round(RUNNING_SESSION_SILENCE_TTL_MS / 60000)}m ` +
          `with no exit frame. The worker still reports holding them; if this is wrong, the agent is hung and never reaped.`,
      );
    }
    const counted = [...conn.runningSessionIds].filter((id) => !silent.includes(id));
    return [...new Set([...counted, ...conn.pendingSessionIds.keys()])];
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
  return extractBearer(c.req.header("authorization"));
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
    // `upgrade` is Hono's `upgradeWebSocket` handler, typed against ITS Env generic; this
    // middleware is a plain `(Context, Next)`. The two are structurally compatible at runtime
    // and this cast is where that impedance is acknowledged rather than spread through the
    // signature (no-unsafe-argument).
    return upgrade(c as Parameters<typeof upgrade>[0], next);
  };
}
