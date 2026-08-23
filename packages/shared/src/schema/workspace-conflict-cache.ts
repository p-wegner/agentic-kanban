import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * The cached `git merge-tree` conflict probe for a workspace's branch against its base,
 * extracted out of `workspaces` (#815, the sixth family after `merge_backoff_*` in #781,
 * `review_preflight_*` / `code_metrics_*` / `latest_symlink_*` in #798 and `merge_gate_*`).
 *
 * This one really is a CACHE — stale-while-revalidate, rebuildable from git at any moment by
 * `applyConflicts` (`services/workspace-summary.service.ts`), which is why it exists at all:
 * the board's hot read path must not spawn git. That makes it the clearest case in the
 * family sequence for its own table, because nothing here is a fact about the workspace; it
 * is a memo about a git question, with its own TTL stamp.
 *
 * "Rebuildable" is NOT a licence to drop it (#798's standing rule, established when
 * `latest_symlink_*` looked retirable and was not): without the memo every board read
 * re-probes git, which is the regression #399/decision 014 exists to prevent. The memo moves;
 * it does not disappear.
 *
 * ABSENT ROW == never probed, which is exactly what a NULL `checked_at` meant: the age
 * computes as `Infinity`, so the revalidation path runs. The reads therefore LEFT JOIN from
 * `workspaces` — an inner join would hide every never-probed workspace from the board.
 *
 * `onDelete: "cascade"`, so the memo dies with its workspace; the FK's leading index is the
 * primary key's own automatic index (#740).
 */
export const workspaceConflictCache = sqliteTable("workspace_conflict_cache", {
  /** The workspace this probe belongs to. PK: one cached probe per workspace. */
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** When the probe last ran. The TTL stamp; absent/NULL = never probed = revalidate now. */
  checkedAt: text("checked_at"),
  /** Whether `git merge-tree` reported a conflict at that moment. */
  hasConflicts: integer("has_conflicts", { mode: "boolean" }),
  /** JSON array of the conflicting paths. */
  files: text("files"),
});

export const workspaceConflictCacheRelations = relations(workspaceConflictCache, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceConflictCache.workspaceId],
    references: [workspaces.id],
  }),
}));
