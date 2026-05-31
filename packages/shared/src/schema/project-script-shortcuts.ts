import { relations } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { projects } from "./projects.js";

export const projectScriptShortcuts = sqliteTable("project_script_shortcuts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  name: text("name").notNull(),
  command: text("command").notNull(),
  workingDir: text("working_dir"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const projectScriptShortcutsRelations = relations(projectScriptShortcuts, ({ one }) => ({
  project: one(projects, {
    fields: [projectScriptShortcuts.projectId],
    references: [projects.id],
  }),
}));
