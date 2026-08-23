import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { projects } from "./projects.js";

export const projectStatuses = sqliteTable("project_statuses", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  // #668 — two statuses with the same name meant two columns called "Todo" (one holding the
  // issues, one permanently empty), and every by-name lookup — the merge path, the monitor,
  // the E2E specs — silently picked whichever came first. A name is how a status is
  // addressed everywhere outside the database, so it has to be unique per project.
  projectNameUnique: uniqueIndex("project_statuses_project_name_unique").on(table.projectId, table.name),
}));

export const projectStatusesRelations = relations(projectStatuses, ({ one, many }) => ({
  project: one(projects, {
    fields: [projectStatuses.projectId],
    references: [projects.id],
  }),
  issues: many(issues),
}));

// Forward reference - issues table is defined in another file
// This will be resolved by the relations system
import { issues } from "./issues.js";
