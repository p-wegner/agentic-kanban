import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
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
