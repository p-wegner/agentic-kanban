import type { Database } from "../db/index.js";
import {
  deleteSessionMessagesForSessions,
  deleteSessionMessagesUpToId,
  getOverflowSessions,
  getSessionIdsForWorkspaces,
  getSessionMessageThresholdId,
  getStaleWorkspaceIds,
} from "../repositories/session-message-pruner.repository.js";

// The interval is a BACKSTOP: the per-session cap is enforced at insert time by
// the broadcast flush path (see session-manager/broadcast.ts, #404), so the
// periodic sweep only needs to catch sessions written outside that path and run
// the terminal-workspace retention purge.
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const MERGED_WORKSPACE_RETENTION_DAYS = 3;
export const MAX_MESSAGES_PER_ACTIVE_SESSION = 2_000;

let activePruneTimeout: ReturnType<typeof setTimeout> | null = null;
let activePruneInterval: ReturnType<typeof setInterval> | null = null;

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
  const staleWorkspaceIds = await getStaleWorkspaceIds(cutoff, database);

  if (staleWorkspaceIds.length === 0) return 0;

  // Fetch all session IDs for those workspaces
  const staleSessionIds = await getSessionIdsForWorkspaces(staleWorkspaceIds, database);

  if (staleSessionIds.length === 0) return 0;

  // Delete in batches of 500 to avoid huge single-statement parameter lists
  let totalDeleted = 0;
  const BATCH = 500;
  for (let i = 0; i < staleSessionIds.length; i += BATCH) {
    const batch = staleSessionIds.slice(i, i + BATCH);
    totalDeleted += await deleteSessionMessagesForSessions(batch, database);
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
  const overflowSessions = await getOverflowSessions(MAX_MESSAGES_PER_ACTIVE_SESSION, database);

  let totalDeleted = 0;
  for (const row of overflowSessions) {
    totalDeleted += await capSessionMessagesForSession(row.sessionId, database);
  }
  return totalDeleted;
}

/**
 * Trim ONE session down to the newest MAX_MESSAGES_PER_ACTIVE_SESSION rows.
 * Cheap: one indexed OFFSET lookup + one ranged delete, both riding the
 * (session_id, id) index from migration 0113. Called from the broadcast flush
 * path as the insert-time ring-buffer cap (#404) and from the periodic
 * capSessionMessages sweep above.
 *
 * Returns the number of rows deleted (0 when the session is within the cap).
 */
export async function capSessionMessagesForSession(sessionId: string, database: Database): Promise<number> {
  // Find the oldest row that should be deleted: order descending (newest first),
  // skip the MAX rows we want to keep, then take 1 — this is the newest row to delete.
  // Delete everything with id <= that row's id to remove exactly the excess oldest rows.
  const thresholdId = await getSessionMessageThresholdId(sessionId, MAX_MESSAGES_PER_ACTIVE_SESSION, database);
  if (thresholdId === null) return 0;
  return deleteSessionMessagesUpToId(sessionId, thresholdId, database);
}

/**
 * Start the background pruning scheduler. Runs immediately on startup (after a
 * short delay) and then every PRUNE_INTERVAL_MS.
 */
export function startSessionMessagePruner(database: Database): void {
  stopSessionMessagePruner();

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
  activePruneTimeout = setTimeout(() => { runPruneCycle().catch(() => {}); }, 30_000);
  activePruneInterval = setInterval(() => { runPruneCycle().catch(() => {}); }, PRUNE_INTERVAL_MS);
}

export function stopSessionMessagePruner(): void {
  if (activePruneTimeout !== null) {
    clearTimeout(activePruneTimeout);
    activePruneTimeout = null;
  }
  if (activePruneInterval !== null) {
    clearInterval(activePruneInterval);
    activePruneInterval = null;
  }
}
