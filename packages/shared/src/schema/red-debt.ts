import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { projects } from "./projects.js";

/**
 * A red-debt ledger entry (#915) — a suite known to be red on a project's base branch,
 * promoted from `base_branch_health` rows + train bisect attribution from a cosmetic
 * annotation (`describeRedBaseAttribution`, which only prefixes a doomed gate's message)
 * into a durable, queryable fact: "this suite is failing, since this commit, and here is
 * who owns paying it down."
 *
 * One OPEN row per (project, suite) — `openRedDebtEntry` upserts on that pair rather than
 * inserting a new row per probe, so the ledger answers "what is red right now", not "every
 * time it was red". `resolvedAt` closes an entry when a probe stops reporting the suite in
 * `failedSuites` (green run breaks the streak, same rule `base_branch_health` already uses).
 */
export const redDebt = sqliteTable("red_debt", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  /** Test-suite identifier, same shape as `base_branch_health.failed_suites` entries. */
  suite: text("suite").notNull(),
  /** The base-branch sha this suite was first observed red at. */
  sinceCommit: text("since_commit").notNull(),
  /** Issue number (as text) this debt was attributed to by bisect, or null if unattributed. */
  attributedIssueId: text("attributed_issue_id"),
  /** Issue number (as text) of the pay-down ticket the refiller filed, or null until filed. */
  ownerIssueId: text("owner_issue_id"),
  /** `flaky` — quarantined via #894's targeted re-run; `real` — a genuine, reproducible red. */
  tag: text("tag").notNull(),
  openedAt: text("opened_at").notNull().$defaultFn(() => new Date().toISOString()),
  /** Null while open. Set when a probe reports the suite green again. */
  resolvedAt: text("resolved_at"),
}, (table) => ({
  projectSuiteIdx: index("idx_red_debt_project_suite").on(table.projectId, table.suite),
  projectOpenIdx: index("idx_red_debt_project_resolved").on(table.projectId, table.resolvedAt),
}));

export const redDebtRelations = relations(redDebt, ({ one }) => ({
  project: one(projects, {
    fields: [redDebt.projectId],
    references: [projects.id],
  }),
}));

export const RED_DEBT_TAGS = ["flaky", "real"] as const;
export type RedDebtTag = (typeof RED_DEBT_TAGS)[number];
