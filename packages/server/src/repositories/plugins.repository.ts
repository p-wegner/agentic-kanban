import { plugins, preferences } from "@agentic-kanban/shared/schema";
import { eq, like } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export type PluginRow = typeof plugins.$inferSelect;

export async function listPluginRows(database: Database = db): Promise<PluginRow[]> {
  return database.select().from(plugins).orderBy(plugins.name);
}

export async function getPluginRowById(id: string, database: Database = db): Promise<PluginRow | null> {
  const rows = await database.select().from(plugins).where(eq(plugins.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getPluginRowBySlug(pluginId: string, database: Database = db): Promise<PluginRow | null> {
  const rows = await database.select().from(plugins).where(eq(plugins.pluginId, pluginId)).limit(1);
  return rows[0] ?? null;
}

/** Insert-or-update keyed on the manifest slug (`plugin_id` unique index). */
export async function upsertPluginRow(
  values: Omit<PluginRow, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string },
  database: Database = db,
): Promise<PluginRow> {
  const now = new Date().toISOString();
  await database
    .insert(plugins)
    .values({ ...values, createdAt: values.createdAt ?? now, updatedAt: values.updatedAt ?? now })
    .onConflictDoUpdate({
      target: plugins.pluginId,
      set: {
        name: values.name,
        sourceUrl: values.sourceUrl,
        localPath: values.localPath,
        version: values.version,
        manifestJson: values.manifestJson,
        updatedAt: values.updatedAt ?? now,
      },
    });
  const row = await getPluginRowBySlug(values.pluginId, database);
  if (!row) throw new Error(`plugin upsert for "${values.pluginId}" did not persist`);
  return row;
}

export async function deletePluginRow(id: string, database: Database = db): Promise<void> {
  await database.delete(plugins).where(eq(plugins.id, id));
}

/**
 * All `plugin_enabled_*` preference rows. Callers pair this with the pure
 * `isPluginEnabledPreferenceKey` matcher and their own projectId filter — the
 * LIKE is just a coarse server-side narrowing.
 */
export async function listPluginEnabledPreferences(
  database: Database = db,
): Promise<Array<{ key: string; value: string }>> {
  return database
    .select({ key: preferences.key, value: preferences.value })
    .from(preferences)
    .where(like(preferences.key, "plugin_enabled_%"));
}
