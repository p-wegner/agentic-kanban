import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * Merge-train siding state (#1192).
 *
 * A train member dropped for a conflict used to be left exactly as it was — no signal to its
 * agent, and the next window released it straight back into the same conflict. This table is
 * what lets the train tell the difference between "never tried" and "already asked to rebase,
 * still waiting" for one member, across ticks and server restarts.
 *
 * ONE row per workspace, written on the first drop and cleared once the branch tip moves (a
 * rebase landed) or the member finally lands on the train. `sidedBranchSha` is the re-admission
 * key: a member is held out of the next window's assembly for as long as its branch tip is
 * still the sha recorded here — the same shape `monitor-gate-recall` uses to gate the
 * sequential review path, applied here to the train's candidate set instead.
 */
export const workspaceTrainSiding = sqliteTable("workspace_train_siding", {
  /** The member this siding state belongs to. PK: at most one live siding per workspace. */
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** Total sidings recorded for this member since the last clear. */
  sidings: integer("sidings").notNull().default(0),
  /** The member branch's tip sha at the last siding — unchanged means still waiting on the rebase. */
  sidedBranchSha: text("sided_branch_sha"),
  /** The train tip sha the member conflicted against, for the /turn message and the ticket comment. */
  conflictTrainTipSha: text("conflict_train_tip_sha"),
  /** When the last siding was recorded (ISO). */
  lastSidedAt: text("last_sided_at"),
  /** Set once, when `sidings` reaches the cap — from then on the member is left withheld, no further nudge. */
  cappedAt: text("capped_at"),
});

export const workspaceTrainSidingRelations = relations(workspaceTrainSiding, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceTrainSiding.workspaceId],
    references: [workspaces.id],
  }),
}));
