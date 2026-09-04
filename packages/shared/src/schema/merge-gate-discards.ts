import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * One row per DISCARDED pre-merge-gate verdict (#1030).
 *
 * The #243 protocol (`services/merge-gate-evidence.ts`) throws a PASSING gate verdict away when
 * either tip moved while the gate ran — a full-suite pass, 20-40 minutes on this repo, whose
 * proof would otherwise name code the gate never saw. Until #1030 that discard survived only as
 * a `console.warn` in a live server log and on the in-memory merge job: `workspace_merge_gate`
 * holds evidence for a token that WAS minted, so by construction it never holds a discard, and
 * `%TEMP%/kanban-dev.log` is truncated on every `pnpm dev`. Measured on #1017: the question
 * "should #243's discard be relaxed to a file-overlap rule?" could only be answered by
 * reconstructing base movement from `git log` committer dates over a window that happened to
 * hold exactly three gate runs.
 *
 * So this table is INSTRUMENTATION: it records what the discard saw — the sha pair per tip, the
 * files the base move touched, and the impact selection the run was made with — and it changes
 * nothing about what `movedDuringGate` decides. Append-only; nothing reads it on the merge path.
 * A row outlives the merge job (in-memory) and the gate evidence (latest-value); it dies only
 * with its workspace (`onDelete: "cascade"`). The workspace FK carries its own leading index
 * (#740) because this is a many-rows-per-workspace table, unlike its PK-keyed siblings.
 */
export const mergeGateDiscards = sqliteTable("merge_gate_discards", {
  id: text("id").primaryKey(),
  /** The workspace whose gate verdict was discarded. */
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** When the discard was decided — i.e. when the gate FINISHED and the tips were re-read. */
  discardedAt: text("discarded_at").notNull(),
  /** Which path ran the gate (`pre-lock-merge`, `monitor-auto-merge`, `review-exit gate`, …). */
  source: text("source").notNull(),
  /** The gate stage the run reached (`verify` / `smoke`). */
  stage: text("stage"),
  /** Wall-clock milliseconds the discarded run cost. */
  durationMs: integer("duration_ms"),
  /** The in-memory `MergeJob.jobId` and 1-based attempt number, when the gate ran under a merge job. */
  jobId: text("job_id"),
  attempt: integer("attempt"),
  /** Which tip `movedDuringGate` reported: `branch` or `base`. */
  moved: text("moved").notNull(),
  /** The branch tip before and after the run. Equal when only the base moved. */
  branchShaBefore: text("branch_sha_before"),
  branchShaAfter: text("branch_sha_after"),
  /** The base tip before and after the run. Equal when only the branch moved. */
  baseShaBefore: text("base_sha_before"),
  baseShaAfter: text("base_sha_after"),
  /**
   * JSON array of paths — `git diff --name-only <base before> <base after>` — when the base
   * moved and the diff could be read; null otherwise. This is the half a future file-overlap
   * argument would be audited against (#1017).
   */
  baseMoveFiles: text("base_move_files"),
  /**
   * JSON of the `GateImpactSelection` the run was made under (#956), null when the gate ran
   * under another selector or could not resolve one. The other half #1017 could not audit.
   */
  impactSelection: text("impact_selection"),
}, (t) => [
  index("idx_merge_gate_discards_workspace").on(t.workspaceId),
]);

export const mergeGateDiscardsRelations = relations(mergeGateDiscards, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [mergeGateDiscards.workspaceId],
    references: [workspaces.id],
  }),
}));
