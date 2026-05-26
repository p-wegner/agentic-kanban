import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { projectStatuses } from "./project-statuses.js";
import { projects } from "./projects.js";

export const issues = sqliteTable("issues", {
  id: text("id").primaryKey(),
  issueNumber: integer("issue_number"),
  title: text("title").notNull(),
  description: text("description"),
  priority: text("priority").notNull().default("medium"),
  issueType: text("issue_type").notNull().default("task"),
  sortOrder: integer("sort_order").notNull().default(0),
  statusId: text("status_id").notNull().references(() => projectStatuses.id),
  projectId: text("project_id").notNull().references(() => projects.id),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  statusChangedAt: text("status_changed_at"),
  skipAutoReview: integer("skip_auto_review", { mode: "boolean" }).notNull().default(false),
  estimate: text("estimate"),
  dueDate: text("due_date"),
}, (table) => ({
  projectIdIdx: index("idx_issues_project_id").on(table.projectId),
  statusIdIdx: index("idx_issues_status_id").on(table.statusId),
}));

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
  dependencies: many(issueDependencies),
}));

import { issueDependencies } from "./issue-dependencies.js";
import { issueTags } from "./tags.js";
import { workspaces } from "./workspaces.js";
