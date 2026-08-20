import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { issues } from "./issues.js";

export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color"),
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const issueTags = sqliteTable("issue_tags", {
  id: text("id").primaryKey(),
  issueId: text("issue_id").notNull().references(() => issues.id),
  tagId: text("tag_id").notNull().references(() => tags.id),
}, (table) => ({
  // Joined on every board load (board-column.repository buildTagMap) — was a full scan (0113).
  issueIdIdx: index("idx_issue_tags_issue_id").on(table.issueId),
  tagIdIdx: index("idx_issue_tags_tag_id").on(table.tagId),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  issueTags: many(issueTags),
}));

export const issueTagsRelations = relations(issueTags, ({ one }) => ({
  issue: one(issues, {
    fields: [issueTags.issueId],
    references: [issues.id],
  }),
  tag: one(tags, {
    fields: [issueTags.tagId],
    references: [tags.id],
  }),
}));
