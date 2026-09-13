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
  /**
   * JSON array of the test-suite paths this probe reported as FAILED (#681 half B), parsed
   * from the FULL verify output before it is tailed into `message`.
   *
   * `null` and `[]` are deliberately different, and the difference is the whole point.
   * `[]` means the probe produced a per-suite verdict and named no failure — a green run
   * writes `[]`, which is what BREAKS a suite's red streak. `null` means no list exists:
   * a `timeout` or `unverified` probe (which learned nothing about any suite), or a row
   * written before this column existed. The rot detector treats a null row as neither
   * extending nor breaking a streak, because inferring "then it passed" from a row that
   * never looked is exactly the class of false verdict #681 exists to catch.
   */
  failedSuites: text("failed_suites"),
  /**
   * True when this row's `green` outcome was reached only after a targeted re-run of a small
   * failed-suite set cleared on the second try (#1110) — the base-health twin of the pre-merge
   * gate's #894 flake retry. `null`/false for every other row, including a first-try green: the
   * absence of a retry is the common case and does not need marking.
   */
  flaky: integer("flaky", { mode: "boolean" }),
  /**
   * JSON snapshot of machine load around this probe (#1110) — CPU/RAM at start and end, plus how
   * long this probe queued behind another verification. Answers the question a bare red/timeout
   * verdict cannot: was the box starved, or is the base actually broken? Null for a row recorded
   * before this column existed, or when the read itself failed (never blocks the probe).
   */
  contention: text("contention"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  projectShaIdx: index("idx_base_branch_health_project_sha").on(table.projectId, table.sha),
  createdAtIdx: index("idx_base_branch_health_created_at").on(table.createdAt),
}));

export const baseBranchHealthRelations = relations(baseBranchHealth, ({ one }) => ({
  project: one(projects, {
    fields: [baseBranchHealth.projectId],
    references: [projects.id],
  }),
}));
