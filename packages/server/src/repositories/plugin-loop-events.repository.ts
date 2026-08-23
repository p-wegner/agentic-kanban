import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { pluginLoopEvents } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { firstRow } from "../lib/first-row.js";

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
  /** Butler pre-read verdict for a gate (#309) — payload { gateId, actionId, reason }. */
  | "gate-recommendation"
  /**
   * Why a gate got NO pre-read — payload { gateId, reason, detail }. Recorded because every
   * bail-out in `computeGateRecommendation` is a silent return, which made a missing chip
   * impossible to attribute (feature off? cold butler? malformed model reply?).
   */
  | "gate-recommendation-skipped"
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

/**
 * Restamp one event in place (#448).
 *
 * The ONLY sanctioned use is collapsing a repeated, byte-identical no-op `advance` onto the row it
 * repeats instead of appending another one — see `collapseRepeatedNoOpAdvance` in
 * `plugin-loop.service.ts` for the full contract. `created_at` moves to the LATEST repeat on
 * purpose: every other reader (the timeline's ordering, `latestPluginLoopEvent`, the monitor's
 * blocked-advance interval gate in `plugin-loop-monitor.ts`) treats it as "when the loop last
 * advanced", and freezing it would make a live loop look stalled. When the run began is preserved
 * in the payload's `firstSeenAt`.
 *
 * The timeline is otherwise append-only; do not generalise this into an "edit any event" helper.
 */
export async function restampPluginLoopEvent(
  id: string,
  payload: unknown,
  createdAt: string,
  database: Database = db,
): Promise<void> {
  await database
    .update(pluginLoopEvents)
    .set({ payloadJson: payload == null ? null : JSON.stringify(payload), createdAt })
    .where(eq(pluginLoopEvents.id, id));
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
  return firstRow(
    database
      .select()
      .from(pluginLoopEvents)
      .where(and(
        eq(pluginLoopEvents.pluginSlug, key.pluginSlug),
        eq(pluginLoopEvents.loopName, key.loopName),
        eq(pluginLoopEvents.projectId, key.projectId),
        eq(pluginLoopEvents.type, type),
      ))
      .orderBy(desc(pluginLoopEvents.createdAt), desc(pluginLoopEvents.id))
      .limit(1)
  );
}

/**
 * The newest `limit` events of one type, newest first (#367).
 *
 * Needed because "how many recommendation attempts has this gate already had?" is a COUNT over
 * one type, and reading the whole 500-event timeline to answer it would put a large scan on every
 * advance — and a blocked loop advances every monitor cycle.
 */
export async function listPluginLoopEventsOfType(
  key: LoopEventKey,
  type: PluginLoopEventType,
  limit = 20,
  database: Database = db,
): Promise<PluginLoopEventRow[]> {
  return database
    .select()
    .from(pluginLoopEvents)
    .where(and(
      eq(pluginLoopEvents.pluginSlug, key.pluginSlug),
      eq(pluginLoopEvents.loopName, key.loopName),
      eq(pluginLoopEvents.projectId, key.projectId),
      eq(pluginLoopEvents.type, type),
    ))
    .orderBy(desc(pluginLoopEvents.createdAt), desc(pluginLoopEvents.id))
    .limit(limit);
}
