import { sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { writeDb } from "../db/index.js";
import type { Database } from "../db/index.js";

/** Read the persisted `stats` JSON blob for a session (or empty if absent). */
export async function selectSessionStats(
  sessionId: string,
  database: Database = writeDb,
) {
  return database.select({ stats: sessions.stats }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
}

/**
 * Persist the `stats` JSON blob for a session. Returns the query promise so the
 * caller can attach its own fire-and-forget `.catch()` / await it.
 */
export function updateSessionStats(
  sessionId: string,
  statsJson: string,
  database: Database = writeDb,
) {
  return database.update(sessions).set({ stats: statsJson }).where(eq(sessions.id, sessionId));
}

/**
 * Batch-insert buffered session messages. Returns the query promise so the
 * caller keeps its fire-and-forget FK-constraint `.catch()` handling.
 */
export function insertSessionMessages(
  sessionId: string,
  rows: Array<{ type: string; data: string | null; exitCode: string | null }>,
  database: Database = writeDb,
) {
  return database.insert(sessionMessages).values(rows.map((r) => ({ sessionId, ...r })));
}

/**
 * Persist the provider session id (e.g. Claude's system/init session_id).
 * Returns the query promise so the caller attaches its fire-and-forget `.catch()`.
 */
export function updateProviderSessionId(
  sessionId: string,
  providerSessionId: string,
  database: Database = writeDb,
) {
  return database.update(sessions).set({ providerSessionId }).where(eq(sessions.id, sessionId));
}
