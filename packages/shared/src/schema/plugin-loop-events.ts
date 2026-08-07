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
}));
