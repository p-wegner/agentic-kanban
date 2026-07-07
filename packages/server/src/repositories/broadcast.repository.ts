import { sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { sanitizeUtf8 } from "@agentic-kanban/shared/lib/sanitize-utf8";
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
 *
 * Sanitized here (not just at the raw-byte read sites) as a last-line guard at the
 * persistence boundary (arch-review #960): `statsJson` is often reassembled from
 * agent stdout text, so a lone surrogate that slipped past an earlier decode would
 * otherwise still reach libsql and panic the process.
 */
export function updateSessionStats(
  sessionId: string,
  statsJson: string,
  database: Database = writeDb,
) {
  return database.update(sessions).set({ stats: sanitizeUtf8(statsJson) }).where(eq(sessions.id, sessionId));
}

/**
 * Batch-insert buffered session messages. Returns the query promise so the
 * caller keeps its fire-and-forget FK-constraint `.catch()` handling.
 *
 * `data` is sanitized here as the persistence-boundary guard (arch-review #960) —
 * see `updateSessionStats` above for why this can't be relied on only upstream.
 */
export function insertSessionMessages(
  sessionId: string,
  rows: Array<{ type: string; data: string | null; exitCode: string | null }>,
  provider: string | null = null,
  database: Database = writeDb,
) {
  // `provider` (arch-review §2.4) records which agent produced these rows so
  // offline summary parsing can route to the right per-provider parser instead
  // of sniffing per-event. Nullable — legacy rows lack it and fall back to
  // detect-provider.
  return database.insert(sessionMessages).values(
    rows.map((r) => ({ sessionId, ...r, provider, data: r.data == null ? null : sanitizeUtf8(r.data) })),
  );
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
