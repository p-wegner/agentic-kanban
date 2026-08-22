/**
 * Stale worker-connection reaper (#706).
 *
 * A worker's socket is only ever removed from the connection map when something
 * DELIVERS a close: the worker disconnects, a reconnect evicts the old socket, or a
 * revoke closes it. A network partition delivers none of those. There is no WebSocket
 * keepalive/ping, so a worker whose machine vanishes leaves its entry in `connections`
 * forever — `isConnected` keeps returning true, the Worker Fleet view keeps rendering a
 * dead peer as connected, and `send` to that socket keeps reporting success. Measured
 * from the other side: a worker read healthy for 68 minutes after its board host was gone.
 *
 * What this does NOT change, deliberately: DISPATCH was never affected, and must not be
 * "fixed". `eligibleWorkers` already requires `effectiveStatus === "online"` AND
 * `isConnected`, and `effectiveStatus` is derived from heartbeat age — so a partitioned
 * worker is already excluded from new work. The defect is purely that the socket map
 * LIES about connection state; this makes it honest using the signal the board already
 * has, with no new wire protocol and no worker-side change.
 *
 * Widening `isConnected` itself was the other option and is the wrong one: it is
 * synchronous and sits on hot paths, so it cannot consult heartbeat age without either
 * going async or reading the DB per call.
 *
 * Two reap reasons, and they are different failures worth telling apart in the log:
 *  - `heartbeat_stale` — the row exists but its heartbeat aged out (the partition case).
 *  - `unregistered` — a live socket for a worker that is no longer in the registry at
 *    all. Revocation already closes sockets directly, so this is the backstop for a row
 *    that disappeared some other way, and leaving it connected would be worse.
 */

import {
  emptyPassReport,
  recordActed,
  recordSkipped,
  type PassReport,
} from "../lib/pass-report.js";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";
import type { WorkerConnectionManager } from "./worker-connection.service.js";
import type { WorkerRegistry } from "./worker-registry.service.js";

export interface WorkerConnectionReaperDeps {
  registry: WorkerRegistry;
  connections: WorkerConnectionManager;
}

export interface WorkerConnectionReapResult extends PassReport {
  /** Worker ids whose socket this pass closed. */
  reaped: string[];
}

/**
 * Sweep period. Deliberately shorter than WORKER_HEARTBEAT_STALE_MS (90s) so a dead
 * peer is reported as gone within roughly one stale-window plus one tick, rather than
 * lingering for an unbounded multiple of it.
 */
export const WORKER_CONNECTION_REAP_INTERVAL_MS = 60 * 1000;

/**
 * Close every live socket whose worker is no longer effectively online.
 *
 * `now` is ISO because it is handed straight to `listWorkersView`, which compares it
 * against persisted heartbeat timestamps.
 */
export async function reapStaleWorkerConnections(
  deps: WorkerConnectionReaperDeps,
  now?: string,
): Promise<WorkerConnectionReapResult> {
  const { registry, connections } = deps;
  const connected = connections.connectedWorkerIds();
  const result: WorkerConnectionReapResult = { ...emptyPassReport(connected.length), reaped: [] };
  if (connected.length === 0) return result;

  const workers = await registry.listWorkersView(now);
  const byId = new Map(workers.map((w) => [w.id, w]));

  for (const workerId of connected) {
    const row = byId.get(workerId);
    const reason = !row ? "unregistered" : row.effectiveStatus === "offline" ? "heartbeat_stale" : null;
    if (!reason) {
      recordSkipped(result, workerId, "live");
      continue;
    }
    // closeConnection also fires the disconnect listeners, which is what makes the
    // rest of the board (fleet view, remote agent service) see the peer as gone.
    if (connections.closeConnection(workerId, reason)) {
      result.reaped.push(workerId);
      recordActed(result, workerId, reason);
    } else {
      // Raced with a real close between connectedWorkerIds() and here — not a failure.
      recordSkipped(result, workerId, "already_closed");
    }
  }
  return result;
}

let handle: PeriodicSweepHandle | null = null;

export function stopWorkerConnectionReaper(): void {
  handle?.stop();
  handle = null;
}

/**
 * Start the periodic reap. Timers are unref'd by `startPeriodicSweep`, so this never
 * keeps the process alive; a tick that throws is logged, never thrown into the timer.
 */
export function startWorkerConnectionReaper(
  deps: WorkerConnectionReaperDeps,
  intervalMs: number = WORKER_CONNECTION_REAP_INTERVAL_MS,
): void {
  stopWorkerConnectionReaper();
  handle = startPeriodicSweep({
    name: "worker-connection-reaper",
    intervalMs,
    tick: async () => {
      const result = await reapStaleWorkerConnections(deps);
      // Silent when there was nothing to reap — a per-minute line reporting zero would
      // drown the log this sweep exists to make trustworthy.
      //
      // The tag is written out literally because `console-tag-ratchet.test.ts` can only
      // see LITERAL tags; routing it through a call would spend one of that ratchet's
      // shrink-only slots on a line that is in fact tagged. That reasoning is now the
      // canonical rule — the caller owns the tag, `formatPassReportBody` is the only
      // formatter — and it lives in `lib/pass-report.ts` (#718, which deleted the tagged
      // `formatPassReport` wrapper this comment used to point at: no call site could
      // adopt it without either double-tagging or pushing that ratchet's baseline up).
      if (result.reaped.length > 0) {
        const detail = result.reasons
          .filter((r) => r.reason !== "live")
          .map((r) => `${r.id}:${r.reason}`)
          .join(", ");
        console.log(
          `[worker-connection-reaper] scanned ${result.scanned}, reaped ${result.reaped.length} stale socket(s) — ${detail}`,
        );
      }
      return result;
    },
  });
}
