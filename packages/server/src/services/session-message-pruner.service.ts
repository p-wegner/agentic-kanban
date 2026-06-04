import { sessionMessages, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const MERGED_WORKSPACE_RETENTION_DAYS = 3;
const MAX_MESSAGES_PER_ACTIVE_SESSION = 2_000;

/**
 * Delete session_messages for workspaces that were merged/closed more than
 * MERGED_WORKSPACE_RETENTION_DAYS ago. These rows are never needed again once
 * a workspace is done — the session output file on disk is the canonical record.
 *
 * Returns the number of rows deleted.
 */
export async function pruneOldSessionMessages(database: Database, nowOverride?: string): Promise<number> {
  const cutoff = new Date((nowOverride ? new Date(nowOverride) : new Date()).getTime() - MERGED_WORKSPACE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Find sessions belonging to old merged/closed workspaces
  const staleWorkspaceRows = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      sql`(${workspaces.status} = 'closed' OR ${workspaces.mergedAt} IS NOT NULL) AND ${workspaces.updatedAt} < ${cutoff}`,
    );

  if (staleWorkspaceRows.length === 0) return 0;

  const staleWorkspaceIds = staleWorkspaceRows.map((w) => w.id);

  // Fetch all session IDs for those workspaces
  const staleSessionRows = await database
    .select({ id: sessions.id })
    .from(sessions)
    .where(inArray(sessions.workspaceId, staleWorkspaceIds));

  if (staleSessionRows.length === 0) return 0;

  const staleSessionIds = staleSessionRows.map((s) => s.id);

  // Delete in batches of 500 to avoid huge single-statement parameter lists
  let totalDeleted = 0;
  const BATCH = 500;
  for (let i = 0; i < staleSessionIds.length; i += BATCH) {
    const batch = staleSessionIds.slice(i, i + BATCH);
    const result = await database
      .delete(sessionMessages)
      .where(inArray(sessionMessages.sessionId, batch));
    totalDeleted += (result as { changes?: number }).changes ?? 0;
  }

  return totalDeleted;
}

/**
 * Cap session_messages rows per session for long-running active sessions.
 * Keeps only the most recent MAX_MESSAGES_PER_ACTIVE_SESSION rows per session
 * that already exceeds the cap (running sessions only — closed session rows are
 * handled by pruneOldSessionMessages above).
 *
 * Returns the number of rows deleted.
 */
export async function capSessionMessages(database: Database): Promise<number> {
  // Find sessions that are still running or recently stopped with too many messages
  const overflowSessions = await database
    .select({ sessionId: sessionMessages.sessionId, count: sql<number>`count(*)`.as("count") })
    .from(sessionMessages)
    .groupBy(sessionMessages.sessionId)
    .having(sql`count(*) > ${MAX_MESSAGES_PER_ACTIVE_SESSION}`);

  let totalDeleted = 0;
  for (const row of overflowSessions) {
    // Find the oldest row that should be deleted: order descending (newest first),
    // skip the MAX rows we want to keep, then take 1 — this is the newest row to delete.
    // Delete everything with id <= that row's id to remove exactly the excess oldest rows.
    const thresholdRows = await database
      .select({ id: sessionMessages.id })
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, row.sessionId))
      .orderBy(desc(sessionMessages.id))
      .limit(1)
      .offset(MAX_MESSAGES_PER_ACTIVE_SESSION);
    if (thresholdRows.length === 0) continue;
    const thresholdId = thresholdRows[0].id;
    const result = await database
      .delete(sessionMessages)
      .where(
        sql`${sessionMessages.sessionId} = ${row.sessionId} AND ${sessionMessages.id} <= ${thresholdId}`,
      );
    totalDeleted += (result as { changes?: number }).changes ?? 0;
  }
  return totalDeleted;
}

/**
 * Start the background pruning scheduler. Runs immediately on startup (after a
 * short delay) and then every PRUNE_INTERVAL_MS.
 */
export function startSessionMessagePruner(database: Database): void {
  async function runPruneCycle() {
    try {
      const deleted = await pruneOldSessionMessages(database);
      if (deleted > 0) {
        console.log(`[pruner] deleted ${deleted} stale session_messages rows`);
      }
      const capped = await capSessionMessages(database);
      if (capped > 0) {
        console.log(`[pruner] capped ${capped} overflow session_messages rows`);
      }
    } catch (err) {
      console.warn("[pruner] session_messages prune cycle error:", err);
    }
  }

  // First run after 30s (let server fully start)
  setTimeout(() => { runPruneCycle().catch(() => {}); }, 30_000);
  setInterval(() => { runPruneCycle().catch(() => {}); }, PRUNE_INTERVAL_MS);
}
