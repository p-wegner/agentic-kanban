import { boardHealthEvents } from "@agentic-kanban/shared/schema";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export interface RawCycleRow {
  cycleId: string;
  minCreatedAt: string;
  maxCreatedAt: string;
  eventTypes: string;
  categories: string;
  summaries: string;
  issueNumbers: string;
}

/**
 * Fetch the most-recent `limit` board-health cycles for a project, grouped by
 * cycleId with their event types/categories/summaries/issue numbers concatenated.
 * Pure read — the monitor-cycle-health service owns the per-cycle classification.
 */
export async function getMonitorCycleRows(
  projectId: string,
  limit: number,
  database: Database = db,
): Promise<RawCycleRow[]> {
  // Use a subquery to get the most-recent `limit` cycleIds first, then aggregate.
  const cycleRows = await database
    .select({
      cycleId: boardHealthEvents.cycleId,
      minCreatedAt: sql<string>`min(${boardHealthEvents.createdAt})`,
      maxCreatedAt: sql<string>`max(${boardHealthEvents.createdAt})`,
      eventTypes: sql<string>`group_concat(${boardHealthEvents.eventType}, '||')`,
      categories: sql<string>`group_concat(coalesce(${boardHealthEvents.category}, ''), '||')`,
      summaries: sql<string>`group_concat(${boardHealthEvents.summary}, '||')`,
      issueNumbers: sql<string>`group_concat(coalesce(${boardHealthEvents.issueNumber}, ''))`,
    })
    .from(boardHealthEvents)
    .where(eq(boardHealthEvents.projectId, projectId))
    .groupBy(boardHealthEvents.cycleId)
    .orderBy(desc(sql`min(${boardHealthEvents.createdAt})`))
    .limit(limit) as RawCycleRow[];

  return cycleRows;
}
