import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

/**
 * A workspace create that is IN FLIGHT (#630).
 *
 * The `workspaces` row lands in ONE transaction at the very END of provisioning, together
 * with the issue's move to In Progress — deliberately, so a rollback leaves no half-state.
 * The cost is that for the minutes provisioning takes (multi-repo: tens of minutes), the
 * create is completely invisible: no row, no claim, nothing. A server restart in that
 * window — and there were nine in one 50-minute stretch on 2026-08-18 — leaves worktrees
 * and branches on disk that the board has never heard of, and the monitor simply starts
 * the ticket again. On `comet` that reached 104 orphaned worktrees across 13 repos against
 * ZERO workspace rows, regenerating indefinitely.
 *
 * This table is the missing marker: written BEFORE the worktree/sibling loop, deleted
 * inside the same transaction that inserts the real workspace row. So a row surviving a
 * restart means exactly one thing — that create died mid-flight — and startup can say so
 * instead of leaving silent debris.
 *
 * It is deliberately NOT a `provisioning` status on `workspaces`: every reader of that
 * table (board, monitor, merge gate, WIP counting) would have to learn a status that has
 * no branch, no worktree and no agent yet.
 */
export const workspaceProvisioning = sqliteTable(
  "workspace_provisioning",
  {
    /** The id the workspace row WILL get, so the marker and the row are the same identity. */
    id: text("id").primaryKey(),
    issueId: text("issue_id").notNull().references(() => issues.id),
    projectId: text("project_id").notNull().references(() => projects.id),
    /** Intended branch — known before the worktree exists, and what the debris is named after. */
    branch: text("branch"),
    /** Leading worktree path, filled in once `setupWorktree` has returned. */
    worktreePath: text("worktree_path"),
    /** Which server process owns this create; a row from another pid after boot is abandoned. */
    serverPid: integer("server_pid").notNull(),
    /** Coarse phase marker, so a report can say WHERE it died rather than just that it did. */
    phase: text("phase").notNull(),
    startedAt: text("started_at").notNull(),
  },
  (table) => [index("idx_workspace_provisioning_issue").on(table.issueId)],
);
