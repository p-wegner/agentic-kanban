import { count, desc, eq } from "drizzle-orm";
import { sessions, sessionMessages, issues } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export type LatestSessionRow = typeof sessions.$inferSelect;

export async function getLatestSessionForWorkspace(
  workspaceId: string,
  database: Database = db,
): Promise<LatestSessionRow | undefined> {
  const rows = await database
    .select()
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId))
    .orderBy(desc(sessions.startedAt))
    .limit(1);
  return rows[0];
}

export async function getLatestSessionStatusForWorkspace(
  workspaceId: string,
  database: Database = db,
): Promise<{ id: string; startedAt: string; triggerType: string | null; status: string } | undefined> {
  const rows = await database
    .select({ id: sessions.id, startedAt: sessions.startedAt, triggerType: sessions.triggerType, status: sessions.status })
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId))
    .orderBy(desc(sessions.startedAt))
    .limit(1);
  return rows[0];
}

export async function markSessionStopped(
  sessionId: string,
  endedAt: string,
  database: Database = db,
): Promise<void> {
  await database
    .update(sessions)
    .set({ status: "stopped", endedAt })
    .where(eq(sessions.id, sessionId));
}

export async function countSessionMessages(
  sessionId: string,
  database: Database = db,
): Promise<number> {
  const [row] = await database
    .select({ cnt: count() })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId));
  return row?.cnt ?? 0;
}

export async function getIssueNumberById(
  issueId: string,
  database: Database = db,
): Promise<number | null> {
  const rows = await database
    .select({ issueNumber: issues.issueNumber })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return rows[0]?.issueNumber ?? null;
}
