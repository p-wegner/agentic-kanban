import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { issues } from "./issues.js";
import { workspaces } from "./workspaces.js";

export const issueComments = sqliteTable(
  "issue_comments",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id").notNull().references(() => issues.id),
    workspaceId: text("workspace_id").references(() => workspaces.id),
    // 'preflight-verdict' | 'preflight-clarification' | 'agent-question' | 'merge-attempt' | 'note'
    kind: text("kind").notNull(),
    // 'user' | 'butler' | 'agent' | 'preflight' | 'system'
    author: text("author").notNull(),
    // markdown text
    body: text("body").notNull(),
    // JSON-encoded structured Q&A pairs for replay / re-inject (nullable)
    payload: text("payload"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    // #738: how many times this exact comment was written. The write path collapses a
    // machine-authored comment that is identical to the newest one in the same
    // (issueId, kind, workspaceId) thread into this counter instead of a new row — 97,798 of
    // the table's 99,797 rows were such a repeat. 1 = written once (the normal case).
    repeatCount: integer("repeat_count").notNull().default(1),
    // When the collapse last happened; NULL when the comment never repeated, so `createdAt`
    // remains the only timestamp for almost every row.
    lastRepeatedAt: text("last_repeated_at"),
  },
  (table) => ({
    issueIdIdx: index("idx_issue_comments_issue_id").on(table.issueId),
    // FK-supporting index (#740): foreign_keys is ON, so every workspace delete had to
    // scan the whole (very large) comments table to check this reference.
    workspaceIdIdx: index("idx_issue_comments_workspace_id").on(table.workspaceId),
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
