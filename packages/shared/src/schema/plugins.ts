import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Installed board plugins (plugin-system core). A plugin is a git repo (or local
 * directory) carrying a `kanban-plugin.json` manifest at its root that declares
 * skills, iframe views (with a serve command), scripts, a butler prompt fragment,
 * and an optional scaffold template. Installation registers the row here; enabling
 * per project is a preference (`plugin_enabled_<pluginSlug>_<projectId>`), never a
 * column, so the same install can serve many projects.
 */
export const plugins = sqliteTable("plugins", {
  id: text("id").primaryKey(),
  /** The manifest's `id` — a unique slug ([a-z0-9-]+), e.g. "refactor-safety-net". */
  pluginId: text("plugin_id").notNull(),
  name: text("name").notNull(),
  /** Git URL the plugin was cloned from; null when registered from a local directory. */
  sourceUrl: text("source_url"),
  /** Where the plugin repo lives on disk (the clone target or the local dir as-is). */
  localPath: text("local_path").notNull(),
  version: text("version"),
  /** Cached parsed manifest (JSON text) as of install/refresh time. */
  manifestJson: text("manifest_json").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  pluginIdIdx: uniqueIndex("idx_plugins_plugin_id").on(table.pluginId),
}));

/**
 * PID of a currently-supervised plugin view server (`views[].serve`), persisted
 * so the NEXT server generation can find and reap it. `tsx watch` restarts the
 * backend on every server-source edit without reaping its spawned children — the
 * new process has no in-memory handle on them, so without this row they are
 * orphaned forever (#228). One row per `(plugin_row_id, view_id, project_id)`,
 * upserted on spawn and deleted on stop/exit/restart-reap.
 */
export const pluginViewProcesses = sqliteTable("plugin_view_processes", {
  id: text("id").primaryKey(),
  pluginRowId: text("plugin_row_id").notNull(),
  viewId: text("view_id").notNull(),
  projectId: text("project_id").notNull(),
  pid: integer("pid").notNull(),
  port: integer("port").notNull(),
  command: text("command").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  keyIdx: uniqueIndex("idx_plugin_view_processes_key").on(table.pluginRowId, table.viewId, table.projectId),
}));
