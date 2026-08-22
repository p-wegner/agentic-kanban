import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";

/**
 * Append-only audit timeline of a plugin loop (#292). Advance results used to
 * evaporate after the API call — reconstructing "what has this loop done, who
 * approved what and when" meant re-deriving it from tickets and prose notes.
 * One row per event, capped per loop by the repository's insert (oldest pruned).
 *
 * `type`: advance | gate-reached | gate-resolved | paused | resumed | converged
 * `payload_json`: type-specific detail — an advance carries the plan summary and
 * created-ticket links; gate-resolved carries the action id and feedback excerpt.
 *
 * Keyed by (plugin_slug, loop_name, project_id) — the same identity as the
 * loop's preference keys, NOT the plugins row UUID, so reinstalling a plugin
 * keeps its history.
 *
 * `project_id` is deliberately FK-LESS (#485), unlike `plugin_view_processes.project_id`
 * which cascades. This is a TRACE table, and some of what it must record is precisely the
 * case where the project cannot be resolved — `gate-recommendation-skipped` for a project
 * that has no row is a real, tested scenario. Its writes are also deliberately wrapped in a
 * swallowing try/catch so a diagnostic can never break the gate flow, which means an FK
 * rejection would not surface as an error but as SILENCE: zero events, indistinguishable
 * from the silent bail-out the trace exists to expose. Orphans are handled where they
 * belong instead — `deleteProjectCascade` deletes these rows explicitly and asserts none
 * survive. See `gate-recommendation-skip-trace.test.ts` for the case that decided it.
 */
export const pluginLoopEvents = sqliteTable("plugin_loop_events", {
  id: text("id").primaryKey(),
  pluginSlug: text("plugin_slug").notNull(),
  loopName: text("loop_name").notNull(),
  projectId: text("project_id").notNull(),
  type: text("type").notNull(),
  payloadJson: text("payload_json"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  loopIdx: index("idx_plugin_loop_events_loop").on(table.pluginSlug, table.loopName, table.projectId, table.createdAt),
  // FK-supporting index (#740): project_id is only the THIRD column of the composite
  // index above, so the cascade check on a project delete was a full scan.
  projectIdIdx: index("idx_plugin_loop_events_project_id").on(table.projectId),
}));
