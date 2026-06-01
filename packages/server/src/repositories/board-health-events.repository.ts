import { randomUUID } from "node:crypto";
import { boardHealthEvents } from "@agentic-kanban/shared/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export type BoardHealthEventType = "cycle_start" | "cycle_end" | "observation" | "action" | "error";

export interface LogBoardHealthEventInput {
  projectId: string;
  cycleId: string;
  eventType: BoardHealthEventType;
  summary: string;
  /** Optional structured context — serialized to JSON. */
  details?: unknown;
}

/** Append one Monitor Butler audit event. Returns the generated id. */
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
    summary: input.summary,
    details: input.details === undefined ? null : JSON.stringify(input.details),
    createdAt: new Date().toISOString(),
  });
  return id;
}

/** Most-recent-first events for a project, optionally filtered by cycle or event types, capped by limit. */
export async function listBoardHealthEvents(
  opts: { projectId: string; cycleId?: string; eventTypes?: BoardHealthEventType[]; limit?: number },
  database: Database = db,
) {
  const conditions = [eq(boardHealthEvents.projectId, opts.projectId)];
  if (opts.cycleId) {
    conditions.push(eq(boardHealthEvents.cycleId, opts.cycleId));
  }
  if (opts.eventTypes && opts.eventTypes.length > 0) {
    conditions.push(inArray(boardHealthEvents.eventType, opts.eventTypes));
  }
  const where = conditions.length === 1 ? conditions[0] : and(...conditions);
  return database
    .select()
    .from(boardHealthEvents)
    .where(where)
    .orderBy(desc(boardHealthEvents.createdAt))
    .limit(opts.limit ?? 50);
}
