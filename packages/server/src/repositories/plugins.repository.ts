import { issues, plugins, preferences, projectStatuses } from "@agentic-kanban/shared/schema";
import { and, eq, like } from "drizzle-orm";
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

export interface LoopIssueRow {
  id: string;
  issueNumber: number | null;
  externalKey: string;
  statusName: string;
}

/**
 * Every issue in a project whose `external_key` marks it as a plugin-loop unit.
 *
 * The loop engine dedupes against this: a unit the planner still reports but that
 * already has a ticket must NOT be re-ticketed, and a unit whose ticket reached a
 * terminal status is what lets the planner's next round move on. Scoped by the
 * `plugin-loop:<slug>:<loop>:` prefix so one project can run several loops.
 */
export async function listPluginLoopIssues(
  projectId: string,
  keyPrefix: string,
  database: Database = db,
): Promise<LoopIssueRow[]> {
  const rows = await database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      externalKey: issues.externalKey,
      statusName: projectStatuses.name,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(and(eq(issues.projectId, projectId), like(issues.externalKey, `${keyPrefix}%`)));
  return rows.flatMap((row) =>
    row.externalKey ? [{ ...row, externalKey: row.externalKey }] : [],
  );
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
