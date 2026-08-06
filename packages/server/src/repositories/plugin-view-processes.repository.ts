import { randomUUID } from "node:crypto";
import { pluginViewProcesses } from "@agentic-kanban/shared/schema";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export type PluginViewProcessRow = typeof pluginViewProcesses.$inferSelect;

/** Insert-or-update keyed on `(pluginRowId, viewId, projectId)` (the unique index). */
export async function upsertPluginViewProcess(
  values: { pluginRowId: string; viewId: string; projectId: string; pid: number; port: number; command: string },
  database: Database = db,
): Promise<void> {
  await database
    .insert(pluginViewProcesses)
    .values({ id: randomUUID(), ...values })
    .onConflictDoUpdate({
      target: [pluginViewProcesses.pluginRowId, pluginViewProcesses.viewId, pluginViewProcesses.projectId],
      set: { pid: values.pid, port: values.port, command: values.command, createdAt: new Date().toISOString() },
    });
}

export async function deletePluginViewProcess(
  pluginRowId: string,
  viewId: string,
  projectId: string,
  database: Database = db,
): Promise<void> {
  await database
    .delete(pluginViewProcesses)
    .where(
      and(
        eq(pluginViewProcesses.pluginRowId, pluginRowId),
        eq(pluginViewProcesses.viewId, viewId),
        eq(pluginViewProcesses.projectId, projectId),
      ),
    );
}

/**
 * Drop every persisted PID row for a plugin (optionally narrowed to one project) — the
 * bulk companion to `stopPluginViews()`, used by uninstall/update/disable, which kill by
 * plugin rather than by view.
 */
export async function deletePluginViewProcessesForPlugin(
  pluginRowId: string,
  projectId?: string,
  database: Database = db,
): Promise<void> {
  const byPlugin = eq(pluginViewProcesses.pluginRowId, pluginRowId);
  await database
    .delete(pluginViewProcesses)
    .where(projectId === undefined ? byPlugin : and(byPlugin, eq(pluginViewProcesses.projectId, projectId)));
}

export async function listPluginViewProcesses(database: Database = db): Promise<PluginViewProcessRow[]> {
  return database.select().from(pluginViewProcesses);
}

export async function deletePluginViewProcessById(id: string, database: Database = db): Promise<void> {
  await database.delete(pluginViewProcesses).where(eq(pluginViewProcesses.id, id));
}
