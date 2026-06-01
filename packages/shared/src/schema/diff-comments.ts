import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

export const diffComments = sqliteTable("diff_comments", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  filePath: text("file_path").notNull(),
  lineNumOld: integer("line_num_old"),
  lineNumNew: integer("line_num_new"),
  side: text("side").notNull().default("new"),
  body: text("body").notNull(),
  resolvedAt: text("resolved_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  workspaceIdIdx: index("idx_diff_comments_workspace_id").on(table.workspaceId),
}));

export const diffCommentsRelations = relations(diffComments, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [diffComments.workspaceId],
    references: [workspaces.id],
  }),
}));
