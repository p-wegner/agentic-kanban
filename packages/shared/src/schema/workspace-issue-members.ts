import { sqliteTable, text, index, primaryKey } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { issues } from "./issues.js";
import { workspaces } from "./workspaces.js";

/**
 * Ticket groups (#661): the ADDITIONAL issues a workspace serves beyond its lead issue.
 *
 * `workspaces.issueId` stays the single NOT NULL lead — every existing 1:1 reader
 * (branch naming/parsing #146, WIP counting, the reconcilers, board projections)
 * keeps operating on the lead unchanged. This table only lists the member issues
 * riding along in the same worktree, so N coupled tickets get ONE agent, ONE review,
 * and ONE pre-merge gate run instead of N.
 *
 * Rows are members only — the lead is deliberately NOT duplicated here, so
 * "is this issue served by a live workspace?" is `issueId = workspaces.issue_id
 * OR issueId IN workspace_issue_members`, and a workspace with no rows here is a
 * plain single-ticket workspace (the overwhelmingly common case).
 *
 * Both FKs cascade: deleting a member issue merely detaches it from the group
 * (the workspace and the other members are untouched); deleting the workspace
 * drops the membership rows with it.
 */
export const workspaceIssueMembers = sqliteTable("workspace_issue_members", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.issueId] }),
  index("idx_workspace_issue_members_issue").on(t.issueId),
]);

export const workspaceIssueMembersRelations = relations(workspaceIssueMembers, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceIssueMembers.workspaceId],
    references: [workspaces.id],
  }),
  issue: one(issues, {
    fields: [workspaceIssueMembers.issueId],
    references: [issues.id],
  }),
}));
