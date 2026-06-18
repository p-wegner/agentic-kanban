import { sessionMessages, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getStaleWorkspaceIds(
  cutoff: string,
  database: Database = db,
): Promise<string[]> {
  const rows = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      sql`(${workspaces.status} = 'closed' OR ${workspaces.mergedAt} IS NOT NULL) AND ${workspaces.updatedAt} < ${cutoff}`,
    );
  return rows.map((w) => w.id);
}

export async function getSessionIdsForWorkspaces(
  workspaceIds: string[],
  database: Database = db,
): Promise<string[]> {
  const rows = await database
    .select({ id: sessions.id })
    .from(sessions)
    .where(inArray(sessions.workspaceId, workspaceIds));
  return rows.map((s) => s.id);
}

export async function deleteSessionMessagesForSessions(
  sessionIds: string[],
  database: Database = db,
): Promise<number> {
  const result = await database
    .delete(sessionMessages)
    .where(inArray(sessionMessages.sessionId, sessionIds));
  return (result as { changes?: number }).changes ?? 0;
}

export async function getOverflowSessions(
  maxMessagesPerSession: number,
  database: Database = db,
) {
  return database
    .select({ sessionId: sessionMessages.sessionId, count: sql<number>`count(*)`.as("count") })
    .from(sessionMessages)
    .groupBy(sessionMessages.sessionId)
    .having(sql`count(*) > ${maxMessagesPerSession}`);
}

export async function getSessionMessageThresholdId(
  sessionId: string,
  keepCount: number,
  database: Database = db,
): Promise<number | null> {
  const rows = await database
    .select({ id: sessionMessages.id })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(desc(sessionMessages.id))
    .limit(1)
    .offset(keepCount);
  return rows.length === 0 ? null : rows[0].id;
}

export async function deleteSessionMessagesUpToId(
  sessionId: string,
  thresholdId: number,
  database: Database = db,
): Promise<number> {
  const result = await database
    .delete(sessionMessages)
    .where(
      sql`${sessionMessages.sessionId} = ${sessionId} AND ${sessionMessages.id} <= ${thresholdId}`,
    );
  return (result as { changes?: number }).changes ?? 0;
}
