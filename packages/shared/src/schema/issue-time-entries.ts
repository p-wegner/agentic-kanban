import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { issues } from "./issues.js";

export const issueTimeEntries = sqliteTable(
  "issue_time_entries",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id").notNull().references(() => issues.id),
    minutes: integer("minutes").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    issueIdIdx: index("idx_issue_time_entries_issue_id").on(table.issueId),
  }),
);

export const issueTimeEntriesRelations = relations(issueTimeEntries, ({ one }) => ({
  issue: one(issues, {
    fields: [issueTimeEntries.issueId],
    references: [issues.id],
  }),
}));
