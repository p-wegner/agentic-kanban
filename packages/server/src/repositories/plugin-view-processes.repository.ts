import { randomUUID } from "node:crypto";
import { pluginViewProcesses } from "@agentic-kanban/shared/schema";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export type PluginViewProcessRow = typeof pluginViewProcesses.$inferSelect;

/**
 * The identity of ONE plugin view — the `(pluginRowId, viewId, projectId)` triple.
 *
 * It was already a concept in this code (the unique index below, and the `viewKey()`
 * cache key in `plugin-views.service.ts`) with no name: every signature carried the
 * three strings positionally, in an order nothing enforced, and every caller
 * re-assembled them by hand. #766.
 *
 * Declared HERE — the lowest layer that needs it — rather than in the views service, so
 * the repository never has to import upwards (`repositories-not-up-to-services` is an
 * error gate in `.dependency-cruiser.cjs`). `plugin-views.service.ts` re-exports it, so
 * the views concern is still where service-side consumers get it from.
 */
export interface PluginViewRef {
  pluginRowId: string;
  viewId: string;
  projectId: string;
}

/** Insert-or-update keyed on `(pluginRowId, viewId, projectId)` (the unique index). */
export async function upsertPluginViewProcess(
  values: PluginViewRef & { pid: number; port: number; command: string },
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
  { pluginRowId, viewId, projectId }: PluginViewRef,
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
