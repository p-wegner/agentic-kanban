import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { issues } from "./issues.js";

export type DependencyType = "depends_on" | "blocked_by" | "related_to" | "duplicates" | "parent_of" | "child_of" | "coupled_with";

export const DEPENDENCY_TYPES: DependencyType[] = [
  "depends_on",
  "blocked_by",
  "related_to",
  "duplicates",
  "parent_of",
  "child_of",
  "coupled_with",
];

export const DEPENDENCY_TYPE_LABELS: Record<DependencyType, string> = {
  depends_on: "Depends on",
  blocked_by: "Blocked by",
  related_to: "Related to",
  duplicates: "Duplicates",
  parent_of: "Parent of",
  child_of: "Child of",
  coupled_with: "Coupled with",
};

/**
 * Symmetric (peer) edge types: the relationship holds in both directions, so the
 * stored `(issueId, dependsOnId)` ordering carries no meaning and cycle detection
 * does not apply. `coupled_with` is a peer edge (two issues touch the same code and
 * are best implemented together); `related_to`/`duplicates` are likewise undirected.
 */
export const SYMMETRIC_DEPENDENCY_TYPES: ReadonlySet<DependencyType> = new Set([
  "related_to",
  "duplicates",
  "coupled_with",
]);

export const issueDependencies = sqliteTable("issue_dependencies", {
  id: text("id").primaryKey(),
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  dependsOnId: text("depends_on_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  type: text("type", { enum: ["depends_on", "blocked_by", "related_to", "duplicates", "parent_of", "child_of", "coupled_with"] }).notNull().$defaultFn(() => "depends_on"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => [
  uniqueIndex("issue_dependencies_unique").on(t.issueId, t.dependsOnId, t.type),
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
