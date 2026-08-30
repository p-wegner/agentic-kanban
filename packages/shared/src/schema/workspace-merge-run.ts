import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * The DURABLE half of a merge job (#945).
 *
 * `services/merge-job.service.ts` tracks a merge's lifecycle in memory, and its header says
 * that is deliberate: "a server restart legitimately forgets it — the merge died with the
 * process too". That reasoning holds for the *job record*, and it is wrong about the
 * *workspace*. Observed live on #919: a gate ran ~15 minutes, a `tsx watch` reload took the
 * process down mid-gate, and afterwards `GET /:id/merge-status` returned `{"job": null}` while
 * the workspace sat `readyForMerge: true`, `status: idle`, `mergedAt: null`. Nothing recorded
 * that a merge had ever been attempted, so there was nothing to explain the stall and nothing
 * to retry from — the workspace looked armed and healthy to every reader including the monitor,
 * and only moved because a human noticed master had not advanced.
 *
 * That is distinct from a gate that FAILS, which records an attempt with a reason and is
 * visibly actionable. Here the evidence of the attempt is destroyed along with it.
 *
 * This table is the minimum that makes the loss recoverable: ONE row per workspace saying a
 * merge is in flight, written when the job starts and deleted when it reaches ANY terminal
 * state. So a row surviving into the next process is, by construction, a merge whose runner
 * died — the same "boot is the one moment nothing has started yet" argument
 * `merge-train-reconciler.ts` (#906) makes for `merge_trains`. `startup/merge-run-reconciler.ts`
 * is what turns such a row into a NAMED outcome instead of silence.
 *
 * Deliberately NOT a mirror of `MergeJob`: attempts, durations and results stay in memory,
 * because the only question a later process can answer about a dead merge is "did one start,
 * and against what". `onDelete: "cascade"`, so the marker dies with its workspace; the FK's
 * leading index is the primary key's own automatic index (#740).
 */
export const workspaceMergeRun = sqliteTable("workspace_merge_run", {
  /** The workspace whose merge is in flight. PK: at most one live merge per workspace. */
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** The in-memory `MergeJob.jobId` this row shadows, so the log can name the same job. */
  jobId: text("job_id").notNull(),
  /** When the merge was submitted. */
  startedAt: text("started_at").notNull(),
  /**
   * Which path submitted it (`merge-endpoint`, `monitor-auto-merge`, …) — the reconciler's
   * report says who to look at, and an operator reading a recovered attempt needs to know
   * whether a human or the monitor asked for it.
   */
  source: text("source"),
  /** The process id that owned the run, for the record; never used to probe liveness. */
  pid: text("pid"),
});

export const workspaceMergeRunRelations = relations(workspaceMergeRun, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMergeRun.workspaceId],
    references: [workspaces.id],
  }),
}));
