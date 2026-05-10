import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { issues } from "./issues.js";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  issueId: text("issue_id").notNull().references(() => issues.id),
  branch: text("branch").notNull(),
  workingDir: text("working_dir"),
  baseBranch: text("base_branch"),
  isDirect: integer("is_direct", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  issue: one(issues, {
    fields: [workspaces.issueId],
    references: [issues.id],
  }),
  sessions: many(sessions),
  diffComments: many(diffComments),
}));

import { sessions } from "./sessions.js";
import { diffComments } from "./diff-comments.js";
