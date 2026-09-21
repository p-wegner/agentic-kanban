import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * A per-workspace operator HOLD on merging (#1164).
 *
 * Before this, the only lever to stop ONE red workspace from being repeatedly re-gated by the
 * monitor walk / auto-merge orchestrator / merge-train reconciler was `auto_merge_disabled_<projectId>`
 * — which freezes merging for the WHOLE project. Observed live: a workspace with a genuinely red
 * gate held all 3 verify slots for over an hour while an unrelated fix sat queued behind it, and
 * the operator's only recourse was killing gate processes by hand (forbidden — has taken the
 * stable board down before) or disabling auto-merge project-wide.
 *
 * ONE row per workspace, present only while held — same shape as `workspace_merge_backoff`
 * (#781): the common case (never held) stores nothing, and "no row" cleanly means "not held"
 * without a boolean column that is false almost everywhere.
 *
 * `onDelete: "cascade"`, so the row dies with its workspace.
 */
export const workspaceMergeHold = sqliteTable("workspace_merge_hold", {
  /** The workspace this hold applies to. PK: at most one live hold per workspace. */
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** Operator-supplied reason, shown wherever the hold is surfaced. */
  reason: text("reason"),
  /** When the hold was placed (ISO). */
  heldAt: text("held_at").notNull(),
});

export const workspaceMergeHoldRelations = relations(workspaceMergeHold, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMergeHold.workspaceId],
    references: [workspaces.id],
  }),
}));
