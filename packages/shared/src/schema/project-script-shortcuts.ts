import { relations } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { projects } from "./projects.js";

export const projectScriptShortcuts = sqliteTable("project_script_shortcuts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  name: text("name").notNull(),
  description: text("description"),
  command: text("command").notNull(),
  cwdMode: text("cwd_mode").notNull().default("project"),
  workingDir: text("working_dir"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  // Migration-only until #812: the shortcut list read, and the index that makes
  // `project_id` FK-supported — it LEADS here, which is what the #740 ratchet requires.
  // #812 read this table as having an unindexed FK precisely because the declaration was
  // missing; the index has existed in the DB since migration 0065.
  projectSortIdx: index("idx_project_script_shortcuts_project_sort").on(table.projectId, table.sortOrder),
}));

export const projectScriptShortcutsRelations = relations(projectScriptShortcuts, ({ one }) => ({
  project: one(projects, {
    fields: [projectScriptShortcuts.projectId],
    references: [projects.id],
  }),
}));
