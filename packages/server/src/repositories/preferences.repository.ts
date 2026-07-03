import { preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";

/**
 * Every accessor also takes a drizzle transaction handle, so multi-pref writes
 * that must be atomic (e.g. auth-rotation's profile write + Bullseye retargets,
 * #986) can pass the `tx` from `withTransaction` instead of duplicating the
 * upsert logic.
 */
export type PreferenceDb = Database | TransactionClient;

export async function getPreference(
  key: string,
  database: PreferenceDb = db,
): Promise<string | null> {
  const rows = await database
    .select()
    .from(preferences)
    .where(eq(preferences.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
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
}
