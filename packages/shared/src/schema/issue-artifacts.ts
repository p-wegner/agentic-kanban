import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { issues } from "./issues.js";
import { workspaces } from "./workspaces.js";

export const issueArtifacts = sqliteTable("issue_artifacts", {
  id: text("id").primaryKey(),
  issueId: text("issue_id").notNull().references(() => issues.id),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  type: text("type").notNull(), // 'image' | 'text' | 'link' | 'video'
  mimeType: text("mime_type"),
  content: text("content").notNull(), // base64 data URL for images, text content, or URL for links
  caption: text("caption"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const issueArtifactsRelations = relations(issueArtifacts, ({ one }) => ({
  issue: one(issues, {
    fields: [issueArtifacts.issueId],
    references: [issues.id],
  }),
  workspace: one(workspaces, {
    fields: [issueArtifacts.workspaceId],
    references: [workspaces.id],
  }),
}));
