import { sessionMessages } from "@agentic-kanban/shared/schema";
import { eq, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * The most recent session_messages rows (type/data/createdAt) for a session,
 * newest-first, capped at 50 — backs the board-status last-output fallback when
 * no .out file is present.
 */
export async function getRecentSessionMessages(
  sessionId: string,
  database: Database = db,
) {
  return database
    .select({ type: sessionMessages.type, data: sessionMessages.data, createdAt: sessionMessages.createdAt })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(desc(sessionMessages.id))
    .limit(50);
}
