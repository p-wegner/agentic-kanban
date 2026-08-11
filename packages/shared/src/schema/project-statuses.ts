import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
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
  // Inner-joined on every board load and the 30s auto-merge tick (0113).
  projectIdIdx: index("idx_project_statuses_project_id").on(table.projectId),
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
