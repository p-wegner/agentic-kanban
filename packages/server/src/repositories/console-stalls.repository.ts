import { sessions, sessionMessages, workspaces, issues } from "@agentic-kanban/shared/schema";
import { and, desc, eq, gte, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export interface RecentEndedSession { issueNumber: number | null; sessionId: string; endedAt: string | null; stderrTail: string[] }

const SESSION_LIMIT = 40;
const STDERR_ROWS = 8;

/**
 * #1449 — the newest ended session per workspace of one project, with the tail of its stderr, so the
 * status console can name a watchdog kill / refused launch / refused push without board.log.
 */
export async function listRecentEndedSessions(projectId: string, sinceIso: string, database: Database = db): Promise<RecentEndedSession[]> {
  const rows = await database
    .select({ sessionId: sessions.id, workspaceId: sessions.workspaceId, endedAt: sessions.endedAt, issueNumber: issues.issueNumber })
    .from(sessions)
    .innerJoin(workspaces, eq(workspaces.id, sessions.workspaceId))
    .innerJoin(issues, eq(issues.id, workspaces.issueId))
    .where(and(eq(issues.projectId, projectId), ne(sessions.status, "running"), gte(sessions.startedAt, sinceIso)))
    .orderBy(desc(sessions.startedAt))
    .limit(SESSION_LIMIT);
  const seen = new Set<string>();
  const out: RecentEndedSession[] = [];
  for (const r of rows) {
    if (seen.has(r.workspaceId)) continue;
    seen.add(r.workspaceId);
    const msgs = await database
      .select({ data: sessionMessages.data })
      .from(sessionMessages)
      .where(and(eq(sessionMessages.sessionId, r.sessionId), eq(sessionMessages.type, "stderr")))
      .orderBy(desc(sessionMessages.id))
      .limit(STDERR_ROWS);
    out.push({ issueNumber: r.issueNumber, sessionId: r.sessionId, endedAt: r.endedAt, stderrTail: msgs.map((m) => m.data ?? "") });
  }
  return out;
}
