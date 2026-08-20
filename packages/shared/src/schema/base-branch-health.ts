import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { projects } from "./projects.js";

/**
 * Per-sha verify result for a project's BASE branch (#491). Answers "is the base branch green
 * right now" — a question nothing previously asked; the only thing that ever ran `verify_script`
 * was a branch's own pre-merge gate, so pre-existing rot on the base was silently charged to
 * whichever innocent branch's gate happened to run next.
 *
 * One row per (project, sha) verify attempt — not deduped/upserted, so repeated verification of
 * the same sha (e.g. a scheduled re-check before the base has moved) keeps its own history rather
 * than overwriting. `getLatestBaseBranchHealth` reads the newest row per project.
 */
export const baseBranchHealth = sqliteTable("base_branch_health", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  /** The base branch's commit SHA this result describes. */
  sha: text("sha").notNull(),
  branch: text("branch").notNull(),
  outcome: text("outcome").notNull(),
  durationMs: integer("duration_ms"),
  /** Human-readable failure summary (verify_script stdout/stderr tail); null when outcome=green. */
  message: text("message"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  projectIdIdx: index("idx_base_branch_health_project_id").on(table.projectId),
  projectShaIdx: index("idx_base_branch_health_project_sha").on(table.projectId, table.sha),
  createdAtIdx: index("idx_base_branch_health_created_at").on(table.createdAt),
}));

export const baseBranchHealthRelations = relations(baseBranchHealth, ({ one }) => ({
  project: one(projects, {
    fields: [baseBranchHealth.projectId],
    references: [projects.id],
  }),
}));
