import { index, sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { projects } from "./projects.js";
import { agentSkills } from "./agent-skills.js";

export const scheduledRuns = sqliteTable("scheduled_runs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  projectId: text("project_id").notNull().references(() => projects.id),
  prompt: text("prompt"),
  skillId: text("skill_id").references(() => agentSkills.id),
  intervalMinutes: integer("interval_minutes").notNull().default(60),
  cronExpression: text("cron_expression"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  systemIssueId: text("system_issue_id"),
  lastRunAt: text("last_run_at"),
  lastRunStatus: text("last_run_status"),
  lastRunWorkspaceId: text("last_run_workspace_id"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const scheduledRunHistory = sqliteTable("scheduled_run_history", {
  id: text("id").primaryKey(),
  scheduledRunId: text("scheduled_run_id").notNull().references(() => scheduledRuns.id),
  projectId: text("project_id").notNull().references(() => projects.id),
  status: text("status").notNull(),
  reason: text("reason"),
  triggeredBy: text("triggered_by").notNull().default("manual"),
  issueId: text("issue_id"),
  workspaceId: text("workspace_id"),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  runStartedAtIdx: index("idx_scheduled_run_history_run_started_at").on(table.scheduledRunId, table.startedAt),
  projectStartedAtIdx: index("idx_scheduled_run_history_project_started_at").on(table.projectId, table.startedAt),
}));
