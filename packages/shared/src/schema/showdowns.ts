import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { issues } from "./issues.js";
import { workspaces } from "./workspaces.js";

export const showdowns = sqliteTable("showdowns", {
  id: text("id").primaryKey(),
  issueId: text("issue_id").notNull().references(() => issues.id),
  /** active | decided */
  status: text("status").notNull().default("active"),
  winnerWorkspaceId: text("winner_workspace_id"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  issueIdIdx: index("idx_showdowns_issue_id").on(table.issueId),
}));

export const showdownsRelations = relations(showdowns, ({ one, many }) => ({
  issue: one(issues, {
    fields: [showdowns.issueId],
    references: [issues.id],
  }),
  contestants: many(workspaces),
}));
