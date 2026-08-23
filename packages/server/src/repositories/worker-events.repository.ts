/**
 * Persistence for the per-worker event timeline (#774).
 *
 * The retention rule lives HERE rather than in a cron: an event log whose bound is a
 * scheduled job is unbounded between runs, and the #738 failure (99,140 issue comments,
 * 127 MB of a 186 MB database) happened with a retention service already in the codebase.
 * Capping at insert time makes the ceiling a property of the write path — the table can
 * hold at most `registered workers x WORKER_EVENT_RETENTION_LIMIT` rows no matter how
 * chatty the fleet is.
 */
import { randomUUID } from "node:crypto";
import { workerEvents } from "@agentic-kanban/shared/schema";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * Maximum events retained PER WORKER. 300 covers the useful window for the failure this
 * table exists for — a #699/#706 reconstruction needs the last few hours of one worker's
 * connects, assignments and exits, not its whole life.
 */
export const WORKER_EVENT_RETENTION_LIMIT = 300;

export interface WorkerEventRow {
  id: string;
  workerId: string;
  type: string;
  sessionId: string | null;
  summary: string;
  payloadJson: string | null;
  createdAt: string;
}

export interface InsertWorkerEventInput {
  workerId: string;
  type: string;
  sessionId?: string | null;
  summary: string;
  payloadJson?: string | null;
  /** ISO — persisted, so `now` (not `nowMs`) per the repo's time-injection rule. */
  now?: string;
}

/** Append one event. Returns the generated id. */
export async function insertWorkerEvent(
  input: InsertWorkerEventInput,
  database: Database = db,
): Promise<string> {
  const id = randomUUID();
  await database.insert(workerEvents).values({
    id,
    workerId: input.workerId,
    type: input.type,
    sessionId: input.sessionId ?? null,
    summary: input.summary,
    payloadJson: input.payloadJson ?? null,
    createdAt: input.now ?? new Date().toISOString(),
  });
  return id;
}

/**
 * Newest-first events for one worker.
 *
 * The tiebreak is SQLite's insertion-ordered `rowid`, NOT the row id (#828). `id` is a
 * random UUID, so two events written inside the same millisecond — a connect immediately
 * followed by a close, which is exactly the #699/#706 flap this timeline exists to make
 * readable — came back in a random order. It looked stable only because a Windows clock
 * ticks in ~15ms steps and separated them; on a 1ms-resolution clock they collide and the
 * timeline can render a disconnect before its own connect.
 */
export async function listWorkerEventRows(
  opts: { workerId: string; limit?: number; types?: string[] },
  database: Database = db,
): Promise<WorkerEventRow[]> {
  const conditions = [eq(workerEvents.workerId, opts.workerId)];
  if (opts.types && opts.types.length > 0) conditions.push(inArray(workerEvents.type, opts.types));
  const rows = await database
    .select()
    .from(workerEvents)
    .where(and(...conditions))
    .orderBy(desc(workerEvents.createdAt), desc(sql`rowid`))
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  return rows.map((r) => ({ ...r, sessionId: r.sessionId ?? null, payloadJson: r.payloadJson ?? null }));
}

/** How many events this worker currently holds — the number the retention cap is against. */
export async function countWorkerEvents(workerId: string, database: Database = db): Promise<number> {
  const rows = await database
    .select({ n: sql<number>`count(*)` })
    .from(workerEvents)
    .where(eq(workerEvents.workerId, workerId));
  return Number(rows[0]?.n ?? 0);
}

/**
 * Delete this worker's events past the retention cap, oldest first. Returns how many rows
 * went. Implemented as "find the cutoff timestamp, delete everything older" rather than a
 * correlated subquery, because SQLite has no `DELETE ... LIMIT` in every build.
 */
export async function pruneWorkerEvents(
  workerId: string,
  limit: number = WORKER_EVENT_RETENTION_LIMIT,
  database: Database = db,
): Promise<number> {
  const keep = await database
    .select({ createdAt: workerEvents.createdAt })
    .from(workerEvents)
    .where(eq(workerEvents.workerId, workerId))
    .orderBy(desc(workerEvents.createdAt), desc(sql`rowid`))
    .limit(limit);
  if (keep.length < limit) return 0;
  const cutoff = keep[keep.length - 1]!.createdAt;
  const doomed = await database
    .select({ id: workerEvents.id })
    .from(workerEvents)
    .where(and(eq(workerEvents.workerId, workerId), lt(workerEvents.createdAt, cutoff)));
  if (doomed.length === 0) return 0;
  await database.delete(workerEvents).where(inArray(workerEvents.id, doomed.map((d) => d.id)));
  return doomed.length;
}

/**
 * Drop a revoked worker's whole timeline. This is what keeps `worker_id` honestly FK-less:
 * the deletion is explicit and tested, exactly like `deleteGitTokensForWorker`.
 */
export async function deleteWorkerEvents(workerId: string, database: Database = db): Promise<number> {
  const rows = await database.select({ id: workerEvents.id }).from(workerEvents).where(eq(workerEvents.workerId, workerId));
  if (rows.length === 0) return 0;
  await database.delete(workerEvents).where(eq(workerEvents.workerId, workerId));
  return rows.length;
}
