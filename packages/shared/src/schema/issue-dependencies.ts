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

/**
 * Per-type semantics (#523).
 *
 * The union, list and labels lived here, but the QUESTIONS the code actually asks —
 * does this type block a start, is it directional, is it symmetric — were re-stated as
 * local sets in a dozen files: `BLOCKING_DEPENDENCY_TYPES` in three services,
 * `BLOCKING_DEP_TYPES` in a fourth, `DEP_TYPES_THAT_BLOCK` in a route, an inline
 * `inArray` in a repository, and `DIRECTIONAL_DEPENDENCY_TYPES` twice inside one file
 * plus a third copy in the CLI.
 *
 * They agree today. The hazard is asymmetric: adding a new blocking type means finding
 * every local set, and missing one silently under-blocks — a ticket starts while a real
 * blocker is open, which looks like a scheduling quirk rather than a bug.
 */
export interface DependencyTypeTraits {
  /** An unresolved dependency of this type prevents the dependent from starting. */
  blocksStart: boolean;
  /** The pair has a direction (A -> B differs from B -> A). */
  directional: boolean;
  /** The relationship reads the same both ways. */
  symmetric: boolean;
}

export const DEPENDENCY_TYPE_TRAITS: Record<DependencyType, DependencyTypeTraits> = {
  depends_on:   { blocksStart: true,  directional: true,  symmetric: false },
  blocked_by:   { blocksStart: true,  directional: true,  symmetric: false },
  parent_of:    { blocksStart: false, directional: true,  symmetric: false },
  child_of:     { blocksStart: false, directional: true,  symmetric: false },
  related_to:   { blocksStart: false, directional: false, symmetric: true },
  duplicates:   { blocksStart: false, directional: false, symmetric: true },
  coupled_with: { blocksStart: false, directional: false, symmetric: true },
};

/** Dependency types whose unresolved edges block a start. Derived, never hand-listed. */
export const BLOCKING_DEPENDENCY_TYPES: readonly DependencyType[] =
  DEPENDENCY_TYPES.filter((t) => DEPENDENCY_TYPE_TRAITS[t].blocksStart);

/** Dependency types that carry a direction. */
export const DIRECTIONAL_DEPENDENCY_TYPES: readonly DependencyType[] =
  DEPENDENCY_TYPES.filter((t) => DEPENDENCY_TYPE_TRAITS[t].directional);

/** Whether an unresolved edge of this type blocks the dependent from starting. */
export function isBlockingDependencyType(type: string): boolean {
  return (DEPENDENCY_TYPE_TRAITS as Record<string, DependencyTypeTraits | undefined>)[type]?.blocksStart === true;
}

/** Whether this dependency type has a direction. */
export function isDirectionalDependencyType(type: string): boolean {
  return (DEPENDENCY_TYPE_TRAITS as Record<string, DependencyTypeTraits | undefined>)[type]?.directional === true;
}
