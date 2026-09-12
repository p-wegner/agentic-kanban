import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
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
  tagIdIdx: index("idx_issue_tags_tag_id").on(table.tagId),
  // #1107: a tag may only be attached to an issue once — `POST /api/issues/:id/tags` is
  // idempotent at the service layer, and this is the DB-level backstop for any caller that
  // bypasses it. Leading on `issueId`, this ALSO serves the by-issue lookup that
  // `idx_issue_tags_issue_id` (board-column.repository buildTagMap, was a full scan — 0113)
  // used to serve alone, which is why that narrower index was dropped in the same migration
  // (index-hygiene ratchet #813: a non-unique index that is a strict prefix of a wider one is
  // redundant).
  issueTagUniqueIdx: uniqueIndex("idx_issue_tags_issue_tag_unique").on(table.issueId, table.tagId),
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
