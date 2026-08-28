import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { projects } from "./projects.js";

/**
 * A persisted release train (#906) — the DB-backed record for what `merge-train.service.ts`
 * used to run as pure per-request scratch: a `label = q<Date.now()>` string held only in the
 * closure of `runTrainStrategy`'s async generator, with its `kanban/train/<label>` git ref
 * deleted in a `finally` no matter the outcome. A `tsx watch` restart mid-gate (or any process
 * death) left no trace a train had ever existed — the #893 shape, but for a whole batch instead
 * of one workspace.
 *
 * This row is the train's identity across a restart. It is written at assembly start (state
 * `assembling`), advanced through `gating` → `landing` → `landed`/`red`, and the startup
 * reconciler (`startup/merge-train-reconciler.ts`) is what turns an `assembling`/`gating` row
 * with no live job into either a resume or an `abandoned` verdict — never a silent drop.
 */
export const MERGE_TRAIN_STATES = [
  "assembling",
  "gating",
  "landing",
  "landed",
  "red",
  "abandoned",
] as const;
export type MergeTrainState = (typeof MERGE_TRAIN_STATES)[number];

export const mergeTrains = sqliteTable("merge_trains", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  /** The scratch label (`trainRefName`'s argument) — kept even though the git ref itself is disposable. */
  label: text("label").notNull(),
  /** Workspace ids requested for the batch, JSON-encoded — the ORDER `computePlan` produced. */
  memberWorkspaceIds: text("member_workspace_ids").notNull(),
  state: text("state").notNull().$type<MergeTrainState>().default("assembling"),
  /**
   * Free-form evidence from the gate run (message, stage, gate run count, dropped/rejected
   * members) — JSON-encoded, following the `base-branch-health.repository.ts` convention of a
   * plain `text` column rather than a typed drizzle JSON mode (#590: this repo has none).
   */
  gateEvidence: text("gate_evidence"),
  /** The bisect outcome when a red batch was split to find the culprit(s) — JSON-encoded. */
  bisectResult: text("bisect_result"),
  /** Set when a row is resumed or marked abandoned by the reconciler rather than dropped silently. */
  reconciledReason: text("reconciled_reason"),
  startedAt: text("started_at").notNull().$defaultFn(() => new Date().toISOString()),
  finishedAt: text("finished_at"),
}, (table) => ({
  projectIdIdx: index("idx_merge_trains_project_id").on(table.projectId),
  stateIdx: index("idx_merge_trains_state").on(table.state),
}));

export const mergeTrainsRelations = relations(mergeTrains, ({ one }) => ({
  project: one(projects, {
    fields: [mergeTrains.projectId],
    references: [projects.id],
  }),
}));
