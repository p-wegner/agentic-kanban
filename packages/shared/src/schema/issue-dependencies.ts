import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { issues } from "./issues.js";

export const issueDependencies = sqliteTable("issue_dependencies", {
  id: text("id").primaryKey(),
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  dependsOnId: text("depends_on_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => [
  uniqueIndex("issue_dependencies_unique").on(t.issueId, t.dependsOnId),
]);

export const issueDependenciesRelations = relations(issueDependencies, ({ one }) => ({
  issue: one(issues, {
    fields: [issueDependencies.issueId],
    references: [issues.id],
  }),
  dependsOn: one(issues, {
    fields: [issueDependencies.dependsOnId],
    references: [issues.id],
  }),
}));
