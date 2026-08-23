import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * The setup-script run for a workspace, extracted out of `workspaces` (#815, the seventh
 * family after `merge_backoff_*` in #781, `review_preflight_*` / `code_metrics_*` /
 * `latest_symlink_*` in #798, and `merge_gate_*` / `conflict_cache_*`).
 *
 * A RUN RECORD whose history is the point: a workspace that comes up `blocked` is diagnosed
 * from exactly this — the command, the exit code, the duration and the two output tails.
 * `born-blocked-reconciler.ts` restamps it on a retry precisely so the operator reads a
 * dated verdict rather than one from five days ago, and `workspace-timeline.service.ts`
 * renders it as two timeline events. Eight columns of that on every row of the hottest table
 * is rent the board's read path pays for a record almost nothing on it wants.
 *
 * Written at creation, in the same transaction as the workspace row — exactly like
 * `workspace_symlink_run` (#798), which this follows almost verbatim. That includes the
 * `state: "skipped"` run a project with no setup script produces, because that is what the
 * columns held and it is distinguishable from "no record at all".
 *
 * ABSENT ROW == no setup run recorded, which is what a NULL `latest_setup_state` meant: the
 * projection maps it to `latestSetup: null`. The reads therefore LEFT JOIN from `workspaces`
 * — an inner join would make every pre-extraction workspace with a bare row unreadable.
 *
 * `onDelete: "cascade"`, so the record dies with its workspace; the FK's leading index is the
 * primary key's own automatic index (#740).
 */
export const workspaceSetupRun = sqliteTable("workspace_setup_run", {
  /** The workspace this run belongs to. PK: one (latest) setup run per workspace. */
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** The setup script as invoked. Null when the project declares none. */
  command: text("command"),
  /** `skipped` | `succeeded` | `failed` — see `workspace-run-records.ts`. */
  state: text("state"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  exitCode: integer("exit_code"),
  durationMs: integer("duration_ms"),
  /** Trailing stdout, capped at write time — the diagnostic half of a blocked workspace. */
  stdoutTail: text("stdout_tail"),
  /** Trailing stderr, capped at write time. What the born-blocked report actually shows. */
  stderrTail: text("stderr_tail"),
});

export const workspaceSetupRunRelations = relations(workspaceSetupRun, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceSetupRun.workspaceId],
    references: [workspaces.id],
  }),
}));
