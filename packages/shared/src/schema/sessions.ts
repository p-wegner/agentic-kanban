import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { workspaces } from "./workspaces.js";
import { sessionMessages } from "./session-messages.js";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  executor: text("executor").notNull().default("claude-code"),
  status: text("status").notNull().default("running"),
  startedAt: text("started_at").notNull().$defaultFn(() => new Date().toISOString()),
  endedAt: text("ended_at"),
  exitCode: text("exit_code"),
  providerSessionId: text("provider_session_id"),
  resumeFromId: text("resume_from_id"),
  stats: text("stats"),
  pid: integer("pid"),
  triggerType: text("trigger_type"),
});

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [sessions.workspaceId],
    references: [workspaces.id],
  }),
  messages: many(sessionMessages),
}));
