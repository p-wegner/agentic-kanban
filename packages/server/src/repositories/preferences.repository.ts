import { preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { recordOperation } from "@agentic-kanban/shared/lib/operation-metrics";
import { onPreferenceWrite } from "@agentic-kanban/shared/lib/checked-preference-write";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";

/**
 * Every accessor also takes a drizzle transaction handle, so multi-pref writes
 * that must be atomic (e.g. auth-rotation's profile write + Bullseye retargets,
 * #986) can pass the `tx` from `withTransaction` instead of duplicating the
 * upsert logic.
 */
export type PreferenceDb = Database | TransactionClient;

/**
 * Counted (#359) because the monitor cycle reads preferences KEY BY KEY on paths where it has
 * already loaded the entire table into a `prefMap` — `runPreMergeGate` alone makes five separate
 * single-row round trips per gated candidate, and `getStackProfile` adds another. #349's fix came
 * from finding 82 synchronous libsql round trips in one scan, so the per-operation count is the
 * evidence needed before deciding whether the same pattern survives here.
 */
export async function getPreference(
  key: string,
  database: PreferenceDb = db,
): Promise<string | null> {
  const startedMs = Date.now();
  try {
    const rows = await database
      .select()
      .from(preferences)
      .where(eq(preferences.key, key))
      .limit(1);
    return rows[0]?.value ?? null;
  } finally {
    recordOperation("db:getPreference", Date.now() - startedMs);
  }
}

export async function setPreference(
  key: string,
  value: string,
  database: PreferenceDb = db,
): Promise<void> {
  const now = new Date().toISOString();
  await database
    .insert(preferences)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: preferences.key,
      set: { value, updatedAt: now },
    });
  invalidatePreferencesCache();
}

export async function getAllPreferences(database: Database = db) {
  return database.select().from(preferences);
}

export async function setPreferences(
  entries: { key: string; value: string }[],
  database: Database = db,
): Promise<void> {
  const now = new Date().toISOString();
  for (const { key, value } of entries) {
    await database
      .insert(preferences)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({
        target: preferences.key,
        set: { value, updatedAt: now },
      });
  }
  invalidatePreferencesCache();
}

// ---------------------------------------------------------------------------
// Short-TTL cache over the full `preferences` table scan (#402).
//
// At idle the server ran ~10 full-table scans per MINUTE from timers alone
// (auto-merge orchestrator 2/tick, stranded-review/plan/zombie reconcilers,
// monitor). The table is small but each scan is a full libsql round trip. This
// cache serves repeated reads within a ~2s window from memory, so all timers
// firing in the same instant share ONE underlying query.
//
// Coherence:
//  - keyed per database handle (WeakMap), so tests with fresh in-memory DBs
//    never see each other's rows;
//  - busted by every write through this repository (`setPreference`/
//    `setPreferences`) and — via the `onPreferenceWrite` hook — by every write
//    through the shared checked path (`setPreferenceChecked`, which backs
//    `updateSettings`, the CLI, and MCP `set_preference` in-process);
//  - writes that bypass both (raw `db.insert(preferences)`, or another PROCESS
//    such as the standalone MCP server writing the same SQLite file) are only
//    bounded by the TTL — which is exactly why it is 2s, far below every
//    consumer's tick interval.
//
// Callers MUST treat the returned rows as read-only (they are shared).
// ---------------------------------------------------------------------------

const PREFS_CACHE_TTL_MS = 2_000;

type PreferenceRow = typeof preferences.$inferSelect;

interface PrefsCacheEntry {
  rows: PreferenceRow[];
  fetchedAtMs: number;
  epoch: number;
}

const prefsCacheByDb = new WeakMap<object, PrefsCacheEntry>();
let prefsCacheEpoch = 0;

/** Drop every cached prefs snapshot (all databases). Cheap — bumps a counter. */
export function invalidatePreferencesCache(): void {
  prefsCacheEpoch++;
}

// Any write through the ONE shared checked path (settings route, CLI, MCP tool,
// plugin/compounding services) busts the cache too, so read-your-own-write holds
// on every in-process write path.
onPreferenceWrite(invalidatePreferencesCache);

/**
 * Full `preferences` scan served from a ~2s in-process cache.
 *
 * `nowMs` is the injectable clock (repo `nowOverride` convention) so tests can
 * cross the TTL boundary without sleeping; `ttlMs` is likewise injectable.
 */
export async function getAllPreferencesCached(
  database: Database = db,
  options: { ttlMs?: number; nowMs?: number } = {},
): Promise<PreferenceRow[]> {
  const ttlMs = options.ttlMs ?? PREFS_CACHE_TTL_MS;
  const nowMs = options.nowMs ?? Date.now();
  const entry = prefsCacheByDb.get(database);
  if (entry && entry.epoch === prefsCacheEpoch && nowMs - entry.fetchedAtMs < ttlMs) {
    return entry.rows;
  }
  const startedMs = Date.now();
  try {
    const rows = await database.select().from(preferences);
    prefsCacheByDb.set(database, { rows, fetchedAtMs: nowMs, epoch: prefsCacheEpoch });
    return rows;
  } finally {
    recordOperation("db:getAllPreferencesCached:miss", Date.now() - startedMs);
  }
}
