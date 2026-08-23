import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * The cached `git diff --shortstat` result for a workspace's branch against its diff ref,
 * extracted out of `workspaces` (#815, the ninth family after `merge_backoff_*` in #781,
 * `review_preflight_*` / `code_metrics_*` / `latest_symlink_*` in #798 and `merge_gate_*` /
 * `conflict_cache_*` / `latest_setup_*` / `summary_*`).
 *
 * Like `workspace_conflict_cache` this is a genuine stale-while-revalidate MEMO, not a fact
 * about the workspace: `getDiffShortstat` can rebuild it from git at any moment. It exists
 * because the board's hot read path must not spawn git per workspace (#399, decision 014).
 * "Rebuildable" is not a licence to drop it — without the memo every board read re-shells to
 * git, which is exactly the regression the projection work exists to prevent.
 *
 * ## Absence is the neutral value here, unlike `summary_*`
 *
 * All five dropped columns were NULLABLE with no default, so a workspace that has never been
 * diffed read as NULL on every one of them. An ABSENT ROW reproduces that exactly: the
 * staleness predicates (`isDiffCacheStale`, the TTL comparisons in
 * `workspace-summary.service.ts` and `workspace-repo-status-batch.service.ts`) all key off
 * `checked_at` being null/absent and revalidate, and `hasNonEmptyDiffStats` /
 * `projectDiffStats` treat a null `files_changed` as "no stats yet". So the reads need no
 * `coalesce` and no `.mapWith(...)` — the LEFT JOIN's own NULLs ARE the previous semantics.
 * That is the difference from `summary_dirty`, which was `NOT NULL DEFAULT TRUE` and so
 * forced every read to coalesce absence back to the default.
 *
 * The LEFT JOIN is still load-bearing for a different reason: an inner join would hide every
 * never-diffed workspace from the board entirely.
 *
 * `onDelete: "cascade"`, so the memo dies with its workspace; the FK's leading index is the
 * primary key's own automatic index (#740).
 */
export const workspaceDiffStatCache = sqliteTable("workspace_diff_stat_cache", {
  /** The workspace this memo belongs to. PK: one cached shortstat per workspace. */
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** When the shortstat last ran. The TTL stamp; absent/NULL = never diffed = revalidate now. */
  checkedAt: text("checked_at"),
  /** Worktree HEAD sha at that moment; a different HEAD invalidates the memo before the TTL does. */
  headSha: text("head_sha"),
  /** `--shortstat` files-changed count. NULL/absent = no stats computed yet. */
  filesChanged: integer("files_changed"),
  /** `--shortstat` insertion count. */
  insertions: integer("insertions"),
  /** `--shortstat` deletion count. */
  deletions: integer("deletions"),
});

export const workspaceDiffStatCacheRelations = relations(workspaceDiffStatCache, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceDiffStatCache.workspaceId],
    references: [workspaces.id],
  }),
}));
