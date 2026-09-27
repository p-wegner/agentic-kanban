import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * The moment a workspace became ready-for-merge (#1253, #1246 follow-up).
 *
 * `getQueuePressureMemberRows` used to read `workspaces.updatedAt` as `readySince`, but that
 * column moves on ANY later write to the row (a rebase, a diff-stat refresh, a review-preflight
 * clear) — so a workspace that has been waiting for hours reads as freshly ready the moment
 * anything else touches it, understating both the oldest-waiting age and arrivals/hour.
 *
 * ONE row per workspace, present only while ready — same "no row = not in that state" shape as
 * `workspace_merge_hold` (#1164): the common case (not ready) stores nothing. `onDelete:
 * "cascade"`, so the row dies with its workspace. Cleared (row deleted) whenever `readyForMerge`
 * goes back to false, and re-written (not merely left alone) on every re-arm, so a workspace that
 * drops out of the queue and re-enters gets a fresh `readySince` rather than reusing a stale one.
 */
export const workspaceReadyForMerge = sqliteTable("workspace_ready_for_merge", {
  /** The workspace this applies to. PK: at most one live row per workspace. */
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** When the workspace became ready-for-merge (ISO). */
  readySince: text("ready_since").notNull(),
});

export const workspaceReadyForMergeRelations = relations(workspaceReadyForMerge, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceReadyForMerge.workspaceId],
    references: [workspaces.id],
  }),
}));
