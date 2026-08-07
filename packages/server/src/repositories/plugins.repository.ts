import { issues, plugins, preferences, projectStatuses, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, like, sql } from "drizzle-orm";
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

/** Escape the LIKE metacharacters (`\`, `%`, `_`) so a prefix matches itself and nothing else. */
export function escapeLikeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
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
 *
 * The prefix is matched as a LITERAL (#250): a loop named `extract_v2` puts a `_` — a
 * single-character LIKE wildcard — into the prefix, so an unescaped match counted a sibling
 * loop's tickets and the monitor's `openTickets > 0` gate then blocked or released the wrong
 * loop. Every wildcard in the prefix is escaped and the pattern carries an explicit
 * `ESCAPE '\'`.
 */
export async function listPluginLoopIssues(
  projectId: string,
  keyPrefix: string,
  database: Database = db,
): Promise<LoopIssueRow[]> {
  const pattern = `${escapeLikeLiteral(keyPrefix)}%`;
  const rows = await database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      externalKey: issues.externalKey,
      statusName: projectStatuses.name,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(and(eq(issues.projectId, projectId), sql`${issues.externalKey} LIKE ${pattern} ESCAPE '\\'`));
  return rows.flatMap((row) =>
    row.externalKey ? [{ ...row, externalKey: row.externalKey }] : [],
  );
}

export interface LoopUnmergedWorkspaceRow {
  workspaceId: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  issueStatusName: string;
}

/**
 * Loop tickets whose builder finished but whose workspace has not landed (#299).
 *
 * This is the loop's silent-stall state: the planner reads the MAIN checkout, so until
 * the merge lands it keeps reporting the step as not-generated — and the external-key
 * dedupe turns every re-advance into a no-op. Detected as: issue matches the loop's
 * key prefix, its status is In Review / AI Reviewed / Done (i.e. the builder is finished),
 * and a workspace for it is still open (not closed) and unmerged.
 */
export async function listPluginLoopUnmergedWorkspaces(
  projectId: string,
  keyPrefix: string,
  database: Database = db,
): Promise<LoopUnmergedWorkspaceRow[]> {
  const pattern = `${escapeLikeLiteral(keyPrefix)}%`;
  const rows = await database
    .select({
      workspaceId: workspaces.id,
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
      issueStatusName: projectStatuses.name,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(and(
      eq(issues.projectId, projectId),
      sql`${issues.externalKey} LIKE ${pattern} ESCAPE '\\'`,
      sql`${workspaces.status} != 'closed'`,
      sql`${workspaces.mergedAt} IS NULL`,
      sql`${projectStatuses.name} IN ('In Review', 'AI Reviewed', 'Done')`,
    ));
  return rows;
}

/**
 * Session stats of every session that ran against a loop's unit tickets (#294).
 * The join is the same shape as the cost-over-time analytics: sessions →
 * workspaces → issues, narrowed to this loop's `external_key` prefix. The
 * caller folds `stats.totalCostUsd` / token counts — parsing the JSON belongs
 * in the service, not the query.
 */
export async function listPluginLoopSessionStats(
  projectId: string,
  keyPrefix: string,
  database: Database = db,
): Promise<Array<{ externalKey: string; stats: string | null }>> {
  const pattern = `${escapeLikeLiteral(keyPrefix)}%`;
  const rows = await database
    .select({ externalKey: issues.externalKey, stats: sessions.stats })
    .from(sessions)
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(and(eq(issues.projectId, projectId), sql`${issues.externalKey} LIKE ${pattern} ESCAPE '\\'`));
  return rows.flatMap((row) => (row.externalKey ? [{ externalKey: row.externalKey, stats: row.stats }] : []));
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
