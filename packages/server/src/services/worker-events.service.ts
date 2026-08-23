/**
 * The per-worker event timeline (#774 — remaining #755 item 1).
 *
 * WHAT WAS MISSING: the board stored nothing about what a worker DID. A registration, a
 * connect, an assignment, a session exit and a held incoming ref all existed only as a
 * `console.*` line on the board's stdout (and, on Windows, the daemon's `-Log`). So the
 * question a #699/#706-class failure actually raises — "in what order did that worker
 * connect, take work and go away?" — was answerable only from scrollback, which a restart
 * discards. This is the durable half.
 *
 * WHY IT IS ALSO THE ANSWER TO #755's OWN CAVEAT: the placement explanation (#755) is
 * evaluated WHEN ASKED, so it answers "why is #N not dispatching right now" well and "why
 * did that session three days ago run on the host" not at all — the recording seam for the
 * latter is inside `resolveWorkerPlacement`'s callers. An event log is the observer-side
 * shape of the same answer: it does not capture the resolver's reasoning, but it does
 * record what the fleet looked like at the time, which is the input that reasoning read.
 *
 * TWO RULES:
 *
 *  1. A WRITE HERE CAN NEVER BREAK A FLEET OPERATION. `recordWorkerEvent` never throws and
 *     never awaits into a caller's critical path — a diagnostic that can fail a
 *     registration or a revoke is worse than no diagnostic. That is also why
 *     `worker_events.worker_id` carries no FK (see the schema comment): an FK rejection on a
 *     fire-and-forget insert surfaces as silence, which is indistinguishable from the gap
 *     the log exists to expose.
 *  2. RETENTION IS AT THE WRITE PATH, not on a schedule. Every insert may prune, capped per
 *     worker, so the table's ceiling is `registered workers x 300` regardless of fleet
 *     traffic (see `worker-events.repository.ts`). #738 is the counter-example: an
 *     unbounded log with a retention service already in the codebase reached 127 MB.
 */
import {
  WORKER_EVENT_RETENTION_LIMIT,
  deleteWorkerEvents,
  insertWorkerEvent,
  listWorkerEventRows,
  pruneWorkerEvents,
  type WorkerEventRow,
} from "../repositories/worker-events.repository.js";
import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * The event vocabulary. Kept HERE rather than in shared because nothing outside the server
 * writes one, and the worker binary's leaf modules must not gain a db-graph import
 * (worker-cli-isolation guard).
 *
 * Several types are declared but NOT yet emitted, because their only honest call sites are
 * in files #774 does not own (`fleet-listener.service.ts` for the WebSocket lifecycle,
 * `agent-remote.service.ts` for assignment and exit, `worker-incoming-refs.service.ts` for
 * the held-ref sweep, and the registry for an effective-status transition). The split is
 * declared in code below rather than left for a reader to notice, and pinned by a test.
 */
export const WORKER_EVENT_TYPES = [
  "registered",
  // NOTE there is no `revoked` type, deliberately: revocation DELETES the worker's whole
  // timeline (`forgetWorkerEvents`, the explicit deletion that makes the FK-less `worker_id`
  // honest), so a `revoked` row would be written and dropped in the same breath. "This worker
  // was revoked" is recorded by the worker row's absence, not by an event nothing can read.
  "status_change",
  "protocol_mismatch",
  "connected",
  "disconnected",
  "assigned",
  "session_exit",
  "ref_held",
  "ref_landed",
  "ref_discarded",
] as const;

export type WorkerEventType = (typeof WORKER_EVENT_TYPES)[number];

/**
 * The subset this change actually emits, and therefore the honest scope of the timeline
 * today. `worker-events-emitter-coverage.test.ts` pins it, so the day a WS lifecycle event
 * starts being written the list has to move with it instead of the docs quietly aging.
 */
export const EMITTED_TYPES: readonly WorkerEventType[] = [
  "registered",
  "protocol_mismatch",
  "ref_landed",
  "ref_discarded",
] as const;

/**
 * Types whose emitters live in files #774 does not own. Named so the gap is greppable, and
 * tracked as **#801**, which names the file each missing emitter belongs in.
 */
export const UNEMITTED_TYPES: readonly WorkerEventType[] = [
  "status_change",
  "connected",
  "disconnected",
  "assigned",
  "session_exit",
  "ref_held",
] as const;

export interface WorkerEvent {
  id: string;
  workerId: string;
  type: string;
  sessionId: string | null;
  summary: string;
  /** Parsed `payload_json`, or null. Parsed HERE so no consumer re-implements the try/catch. */
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface RecordWorkerEventInput {
  workerId: string;
  type: WorkerEventType;
  summary: string;
  sessionId?: string | null;
  payload?: Record<string, unknown>;
  /** ISO timestamp override (persisted value, so `now`, per the repo's convention). */
  now?: string;
  database?: Database;
}

/**
 * Append an event. NEVER throws and NEVER rejects — rule 1 above. Awaiting it is safe from
 * a request handler; not awaiting it is safe too, which is why the callers in
 * `routes/workers.ts` use `void`.
 */
export async function recordWorkerEvent(input: RecordWorkerEventInput): Promise<void> {
  const database = input.database ?? realDb;
  try {
    await insertWorkerEvent(
      {
        workerId: input.workerId,
        type: input.type,
        sessionId: input.sessionId ?? null,
        summary: input.summary,
        payloadJson: input.payload ? JSON.stringify(input.payload) : null,
        now: input.now,
      },
      database,
    );
    // Probabilistic prune, same shape as `logBoardHealthEvent`: the cap must hold without
    // paying a count+delete on every insert. ~1 in 25 writes, so a worker that reaches the
    // cap is trimmed within a handful of events of crossing it.
    if (Math.random() < 0.04) {
      await pruneWorkerEvents(input.workerId, WORKER_EVENT_RETENTION_LIMIT, database);
    }
  } catch (err) {
    console.warn(`[worker-events] failed to record ${input.type} for worker ${input.workerId}: ${String(err)}`);
  }
}

function parsePayload(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toEvent(row: WorkerEventRow): WorkerEvent {
  return {
    id: row.id,
    workerId: row.workerId,
    type: row.type,
    sessionId: row.sessionId,
    summary: row.summary,
    payload: parsePayload(row.payloadJson),
    createdAt: row.createdAt,
  };
}

/** Newest-first timeline for one worker. */
export async function listWorkerEvents(opts: {
  workerId: string;
  limit?: number;
  types?: string[];
  database?: Database;
}): Promise<WorkerEvent[]> {
  const rows = await listWorkerEventRows(
    { workerId: opts.workerId, limit: opts.limit, types: opts.types },
    opts.database ?? realDb,
  );
  return rows.map(toEvent);
}

/**
 * Drop a revoked worker's timeline. Called from the revoke route — the explicit deletion
 * that makes the FK-less `worker_id` honest rather than a shortcut.
 */
export async function forgetWorkerEvents(workerId: string, database?: Database): Promise<number> {
  try {
    return await deleteWorkerEvents(workerId, database ?? realDb);
  } catch (err) {
    console.warn(`[worker-events] failed to delete events for worker ${workerId}: ${String(err)}`);
    return 0;
  }
}

export { WORKER_EVENT_RETENTION_LIMIT };
