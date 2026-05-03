import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { projectStatuses } from "./project-statuses.js";
import { projects } from "./projects.js";

export const issues = sqliteTable("issues", {
  id: text("id").primaryKey(),
  issueNumber: integer("issue_number"),
  title: text("title").notNull(),
  description: text("description"),
  priority: text("priority").notNull().default("medium"),
  sortOrder: integer("sort_order").notNull().default(0),
  statusId: text("status_id").notNull().references(() => projectStatuses.id),
  projectId: text("project_id").notNull().references(() => projects.id),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const issuesRelations = relations(issues, ({ one, many }) => ({
  status: one(projectStatuses, {
    fields: [issues.statusId],
    references: [projectStatuses.id],
  }),
  project: one(projects, {
    fields: [issues.projectId],
    references: [projects.id],
  }),
  tags: many(issueTags),
  workspaces: many(workspaces),
}));

import { issueTags } from "./tags.js";
import { workspaces } from "./workspaces.js";
