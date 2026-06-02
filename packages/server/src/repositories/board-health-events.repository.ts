import { randomUUID } from "node:crypto";
import { boardHealthEvents } from "@agentic-kanban/shared/schema";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export type BoardHealthEventType = "cycle_start" | "cycle_end" | "observation" | "action" | "error";

/** Business-level grouping shown in the notification center filter bar. */
export type BoardHealthEventCategory = "merge" | "launch" | "server" | "refill" | "smoke_check";

/** Maximum events retained per project before old ones are pruned. */
const RETENTION_LIMIT = 500;

export interface LogBoardHealthEventInput {
  projectId: string;
  cycleId: string;
  eventType: BoardHealthEventType;
  /** Business-level category for the notification center filter. */
  category?: BoardHealthEventCategory;
  /** Issue number this event relates to, if applicable. */
  issueNumber?: number;
  summary: string;
  /** Optional structured context — serialized to JSON. */
  details?: unknown;
}

/** Append one Monitor Butler audit event. Returns the generated id. Fire-and-forgets a prune after every 50th insert. */
export async function logBoardHealthEvent(
  input: LogBoardHealthEventInput,
  database: Database = db,
): Promise<string> {
  const id = randomUUID();
  await database.insert(boardHealthEvents).values({
    id,
    projectId: input.projectId,
    cycleId: input.cycleId,
    eventType: input.eventType,
    category: input.category ?? null,
    issueNumber: input.issueNumber ?? null,
    summary: input.summary,
    details: input.details === undefined ? null : JSON.stringify(input.details),
    createdAt: new Date().toISOString(),
  });

  // Prune every ~50 inserts (probabilistic to avoid per-row overhead)
  if (Math.random() < 0.02) {
    pruneOldBoardHealthEvents(input.projectId, database).catch(() => {});
  }

  return id;
}

/** Fetch a single board health event by id, or null if not found. */
export async function getBoardHealthEvent(
  id: string,
  database: Database = db,
) {
  const rows = await database
    .select()
    .from(boardHealthEvents)
    .where(eq(boardHealthEvents.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Most-recent-first events for a project, optionally filtered by cycle, event types, or categories, capped by limit. */
export async function listBoardHealthEvents(
  opts: {
    projectId: string;
    cycleId?: string;
    eventTypes?: BoardHealthEventType[];
    categories?: BoardHealthEventCategory[];
    limit?: number;
  },
  database: Database = db,
) {
  const conditions = [eq(boardHealthEvents.projectId, opts.projectId)];
  if (opts.cycleId) {
    conditions.push(eq(boardHealthEvents.cycleId, opts.cycleId));
  }
  if (opts.eventTypes && opts.eventTypes.length > 0) {
    conditions.push(inArray(boardHealthEvents.eventType, opts.eventTypes));
  }
  if (opts.categories && opts.categories.length > 0) {
    conditions.push(inArray(boardHealthEvents.category, opts.categories));
  }
  const where = conditions.length === 1 ? conditions[0] : and(...conditions);
  return database
    .select()
    .from(boardHealthEvents)
    .where(where)
    .orderBy(desc(boardHealthEvents.createdAt))
    .limit(opts.limit ?? 50);
}

/**
 * Delete old events for a project beyond the retention limit (keeps the most recent RETENTION_LIMIT rows).
 * Call this after inserts to keep the table bounded.
 */
export async function pruneOldBoardHealthEvents(
  projectId: string,
  database: Database = db,
): Promise<void> {
  const cutoff = await database
    .select({ createdAt: boardHealthEvents.createdAt })
    .from(boardHealthEvents)
    .where(eq(boardHealthEvents.projectId, projectId))
    .orderBy(desc(boardHealthEvents.createdAt))
    .limit(1)
    .offset(RETENTION_LIMIT - 1);

  if (cutoff.length === 0) return;

  await database
    .delete(boardHealthEvents)
    .where(
      and(
        eq(boardHealthEvents.projectId, projectId),
        lt(boardHealthEvents.createdAt, cutoff[0].createdAt),
      ),
    );
}
