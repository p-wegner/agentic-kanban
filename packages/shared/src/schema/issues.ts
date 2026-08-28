import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
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
  // Optional link to an issue in an external tracker (Jira, Linear, GitHub, ...).
  // externalKey is the human-readable identifier (e.g. "PROJ-123"); externalUrl is the http/https deep link.
  // KNOWN DEBT (#201): plugin loops (plugin-loop.service.ts) also stash their own
  // machine-generated dedupe identity here as a `plugin-loop:<slug>:<loop>:<unit>` prefixed
  // string, via pluginLoopUnitKey(). It works but overloads a column documented (and rendered
  // in the UI) as a genuine external-tracker link. If a second board feature ever needs the
  // same "created by a machine, dedupe on re-run" identity, split it into a dedicated nullable
  // `source_key` column (or typed origin JSON) instead of growing this overload further.
  externalKey: text("external_key"),
  externalUrl: text("external_url"),
  // Configurable workflow graph this issue flows through (null = legacy status-only flow).
  workflowTemplateId: text("workflow_template_id"),
  // The node the issue currently sits on; the board status is derived from it.
  currentNodeId: text("current_node_id"),
  // Cached result of AI-predicted files this issue will touch (JSON array of {path,reason,confidence}).
  touchedFilesJson: text("touched_files_json"),
  // Acceptance-criteria checklist items (JSON array of {id,text,completed}).
  checklistJson: text("checklist_json"),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  milestoneId: text("milestone_id").references(() => milestones.id),
  // #917 — scored ticket selection: the Todo-pull loop's most recent evaluation of this
  // issue as a start candidate. Null until the issue has been scored once.
  lastStartScore: real("last_start_score"),
  lastStartScoreComponentsJson: text("last_start_score_components_json"),
  lastStartScoredAt: text("last_start_scored_at"),
}, (table) => ({
  milestoneIdIdx: index("idx_issues_milestone_id").on(table.milestoneId),
  statusIdStatusChangedAtIdx: index("idx_issues_status_id_status_changed_at").on(table.statusId, table.statusChangedAt),
  projectIdStatusIdStatusChangedAtIdx: index("idx_issues_project_id_status_id_status_changed_at").on(table.projectId, table.statusId, table.statusChangedAt),
  projectIdIssueNumberIdx: uniqueIndex("idx_issues_project_id_issue_number").on(table.projectId, table.issueNumber),
  // Plugin-loop unit lookups: three prefix-LIKE queries on external_key per loop per
  // poll, always project-scoped (migration 0115, 2026-08-11 perf audit).
  projectIdExternalKeyIdx: index("idx_issues_project_external_key").on(table.projectId, table.externalKey),
  // Board/graph list shape "WHERE project_id = ? ORDER BY sort_order" — served
  // index-ordered, no temp B-tree sort (migration 0116, 2026-08-11 perf audit G14e).
  projectIdSortOrderIdx: index("idx_issues_project_sort_order").on(table.projectId, table.sortOrder),
  // Migration-only until #812: project-scoped issue lists ordered by creation.
  projectIdCreatedAtIdx: index("idx_issues_project_id_created_at").on(table.projectId, table.createdAt),
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
  milestone: one(milestones, {
    fields: [issues.milestoneId],
    references: [milestones.id],
  }),
  tags: many(issueTags),
  workspaces: many(workspaces),
  dependencies: many(issueDependencies),
}));

import { issueDependencies } from "./issue-dependencies.js";
import { issueTags } from "./tags.js";
import { workspaces } from "./workspaces.js";
import { milestones } from "./milestones.js";
