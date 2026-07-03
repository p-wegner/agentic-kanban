import { runtimeState } from "@agentic-kanban/shared/schema";
import { and, eq, isNotNull, like, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * Persistence for the `runtime_state` table — ephemeral / unbounded runtime state
 * kept OUT of `preferences` (the closed, registry-backed config set). See #975 and
 * `@agentic-kanban/shared/schema/runtime-state`. Mirrors the `preferences.repository`
 * shape (`get`/`set`/`setMany`) plus TTL-aware helpers for the unbounded namespaces.
 */

export type RuntimeStateRow = typeof runtimeState.$inferSelect;

/** Read a runtime-state value, or null when absent. Expired rows are NOT filtered
 *  here (cleanup is a separate sweep); callers that care about TTL should rely on
 *  {@link cleanupExpiredRuntimeState} having removed stale rows. */
export async function getRuntimeState(
  key: string,
  database: Database = db,
): Promise<string | null> {
  const rows = await database
    .select()
    .from(runtimeState)
    .where(eq(runtimeState.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}

/**
 * Upsert a runtime-state value. Pass `opts.ttlMs` to stamp an `expiresAt` of
 * `now + ttlMs` (for unbounded namespaces that should be swept), or `opts.expiresAt`
 * to set/clear the expiry explicitly. With neither, `expiresAt` is cleared to null.
 */
export async function setRuntimeState(
  key: string,
  value: string,
  database: Database = db,
  opts?: { ttlMs?: number; expiresAt?: string | null },
): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt =
    opts?.expiresAt !== undefined
      ? opts.expiresAt
      : opts?.ttlMs !== undefined
        ? new Date(now.getTime() + opts.ttlMs).toISOString()
        : null;
  await database
    .insert(runtimeState)
    .values({ key, value, updatedAt: nowIso, expiresAt })
    .onConflictDoUpdate({
      target: runtimeState.key,
      set: { value, updatedAt: nowIso, expiresAt },
    });
}

/** Delete a single runtime-state row (no-op when absent). */
export async function deleteRuntimeState(
  key: string,
  database: Database = db,
): Promise<void> {
  await database.delete(runtimeState).where(eq(runtimeState.key, key));
}

/** All runtime-state rows whose key starts with `prefix`. (`_` in a LIKE pattern is a
 *  single-char wildcard but still matches the literal underscores in our keys; the
 *  runtime-state prefixes are distinctive enough that over-match is not a concern —
 *  same convention as the 0097 data migration.) */
export async function getRuntimeStateByPrefix(
  prefix: string,
  database: Database = db,
): Promise<RuntimeStateRow[]> {
  return database
    .select()
    .from(runtimeState)
    .where(like(runtimeState.key, `${prefix}%`));
}

/** Delete every runtime-state row whose key starts with `prefix`. */
export async function deleteRuntimeStateByPrefix(
  prefix: string,
  database: Database = db,
): Promise<void> {
  await database.delete(runtimeState).where(like(runtimeState.key, `${prefix}%`));
}

/**
 * Sweep expired rows: delete every row with a non-null `expiresAt` strictly before
 * `now`. `now` is injected (ISO string) so staleness stays deterministic in tests.
 * Returns the number of rows removed.
 */
export async function cleanupExpiredRuntimeState(
  now: string,
  database: Database = db,
): Promise<number> {
  const result = await database
    .delete(runtimeState)
    .where(and(isNotNull(runtimeState.expiresAt), lt(runtimeState.expiresAt, now)));
  return (result as { rowsAffected?: number; changes?: number }).rowsAffected
    ?? (result as { changes?: number }).changes
    ?? 0;
}
