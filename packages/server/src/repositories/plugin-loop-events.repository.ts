import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { pluginLoopEvents } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * Persisted loop timeline (#292). Append-only with a per-loop cap enforced at
 * insert time so a long-running loop cannot grow the table unboundedly; 500
 * events comfortably covers months of advances while staying trivial to render.
 */
export const LOOP_EVENTS_CAP_PER_LOOP = 500;

export type PluginLoopEventType =
  | "advance"
  | "gate-reached"
  | "gate-resolved"
  | "paused"
  | "resumed"
  | "converged";

export type PluginLoopEventRow = typeof pluginLoopEvents.$inferSelect;

export interface LoopEventKey {
  pluginSlug: string;
  loopName: string;
  projectId: string;
}

export async function insertPluginLoopEvent(
  key: LoopEventKey,
  type: PluginLoopEventType,
  payload: unknown,
  database: Database = db,
): Promise<void> {
  await database.insert(pluginLoopEvents).values({
    id: randomUUID(),
    pluginSlug: key.pluginSlug,
    loopName: key.loopName,
    projectId: key.projectId,
    type,
    payloadJson: payload == null ? null : JSON.stringify(payload),
  });
  // Prune beyond the cap. Cheap: runs per insert, and the subquery is index-backed.
  await database.run(sql`
    DELETE FROM plugin_loop_events
    WHERE plugin_slug = ${key.pluginSlug} AND loop_name = ${key.loopName} AND project_id = ${key.projectId}
      AND id NOT IN (
        SELECT id FROM plugin_loop_events
        WHERE plugin_slug = ${key.pluginSlug} AND loop_name = ${key.loopName} AND project_id = ${key.projectId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${LOOP_EVENTS_CAP_PER_LOOP}
      )
  `);
}

/** Newest first. */
export async function listPluginLoopEvents(
  key: LoopEventKey,
  limit = 100,
  database: Database = db,
): Promise<PluginLoopEventRow[]> {
  return database
    .select()
    .from(pluginLoopEvents)
    .where(and(
      eq(pluginLoopEvents.pluginSlug, key.pluginSlug),
      eq(pluginLoopEvents.loopName, key.loopName),
      eq(pluginLoopEvents.projectId, key.projectId),
    ))
    .orderBy(desc(pluginLoopEvents.createdAt), desc(pluginLoopEvents.id))
    .limit(limit);
}

/** The newest event of one type (e.g. the current gate-reached) — null when none. */
export async function latestPluginLoopEvent(
  key: LoopEventKey,
  type: PluginLoopEventType,
  database: Database = db,
): Promise<PluginLoopEventRow | null> {
  const rows = await database
    .select()
    .from(pluginLoopEvents)
    .where(and(
      eq(pluginLoopEvents.pluginSlug, key.pluginSlug),
      eq(pluginLoopEvents.loopName, key.loopName),
      eq(pluginLoopEvents.projectId, key.projectId),
      eq(pluginLoopEvents.type, type),
    ))
    .orderBy(desc(pluginLoopEvents.createdAt), desc(pluginLoopEvents.id))
    .limit(1);
  return rows[0] ?? null;
}
