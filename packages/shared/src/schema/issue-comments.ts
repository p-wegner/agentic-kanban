import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { issues } from "./issues.js";
import { workspaces } from "./workspaces.js";

export const issueComments = sqliteTable(
  "issue_comments",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id").notNull().references(() => issues.id),
    workspaceId: text("workspace_id").references(() => workspaces.id),
    // 'preflight-clarification' | 'agent-question' | 'merge-attempt' | 'note'
    kind: text("kind").notNull(),
    // 'user' | 'butler' | 'agent' | 'preflight' | 'system'
    author: text("author").notNull(),
    // markdown text
    body: text("body").notNull(),
    // JSON-encoded structured Q&A pairs for replay / re-inject (nullable)
    payload: text("payload"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    issueIdIdx: index("idx_issue_comments_issue_id").on(table.issueId),
  }),
);

export const issueCommentsRelations = relations(issueComments, ({ one }) => ({
  issue: one(issues, {
    fields: [issueComments.issueId],
    references: [issues.id],
  }),
  workspace: one(workspaces, {
    fields: [issueComments.workspaceId],
    references: [workspaces.id],
  }),
}));
