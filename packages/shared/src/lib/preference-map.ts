/**
 * Preference row → lookup map (#494).
 *
 * 31 call sites hand-wrote `new Map(rows.map((r) => [r.key, r.value]))`. What they share is
 * the PROJECTION, not the load — and that distinction is the whole point of this module's
 * shape.
 *
 * The ticket proposed `loadPrefMap(database)`, which would also own the query. That is not
 * safe here, because the call sites deliberately read from six different sources:
 *
 *   - `getAllPreferencesCached` (5 sites) — the #402 short-TTL cache. Two callers in
 *     `auto-merge-orchestrator` share one underlying query per tick; routing them through a
 *     database-owning helper would silently double the queries per tick.
 *   - `getAutoMergePreferences` (1 site, `board-status.ts`) — a FILTERED query. A helper that
 *     picks the source would turn it into a full scan.
 *   - plus `getAllPreferences`, `getAllPreferenceRows`, `selectAllPreferences`, and raw
 *     `database.select(...)` — including one over `runtime_state`, a different table entirely.
 *
 * So this takes rows the caller already loaded. The source stays a decision at the call site,
 * where the cache/filter tradeoff is actually visible.
 *
 * Pure by construction — no drizzle, no schema, no node builtins — so it stays client-safe
 * per the #791/#596 barrel rules.
 */

/** The shape every preference-ish row shares: a string key and a string value. */
export interface KeyValueRow {
  key: string;
  value: string;
}

/**
 * Project `{key, value}` rows into a lookup map.
 *
 * Later rows win on a duplicate key, matching the previous inline `new Map(...)` behaviour
 * exactly — worth stating because the preference tables have a unique key, but the raw
 * `database.select` sites do not all guarantee it.
 */
export function toPrefMap(rows: readonly KeyValueRow[]): Map<string, string> {
  return new Map(rows.map((row) => [row.key, row.value]));
}
