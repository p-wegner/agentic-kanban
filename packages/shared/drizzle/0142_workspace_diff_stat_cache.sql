-- #815: extract the NINTH column family out of `workspaces` (after `merge_backoff_*` in
-- #781, `review_preflight_*` / `code_metrics_*` / `latest_symlink_*` in #798, and
-- `merge_gate_*` in 0138 / `conflict_cache_*` in 0139 / `latest_setup_*` in 0140 /
-- `summary_*` in 0141).
--
-- `diff_stat_cache_*` (5 columns) -> `workspace_diff_stat_cache`, keyed by `workspace_id`.
--
-- WHAT THESE COLUMNS ARE: the memoized `git diff --shortstat` for a workspace's branch
-- against its diff ref -- files changed / insertions / deletions, plus the TTL stamp and the
-- HEAD sha the numbers were computed at. Pure derived cache: `getDiffShortstat` rebuilds it
-- from git at any moment. It exists so the board's hot read never shells out to git per
-- workspace (#399, decision 014). Rebuildable is NOT a licence to drop it (#798's standing
-- rule): the memo moves, it does not disappear.
--
-- ABSENCE IS THE NEUTRAL VALUE HERE, unlike `summary_*` in 0141. All five columns were
-- nullable with no default, so a never-diffed workspace already read NULL on every one of
-- them, and an absent row reproduces that exactly. Every staleness predicate keys off
-- `checked_at` being null (`isDiffCacheStale` computes an infinite age; the TTL comparisons
-- in `workspace-summary.service.ts` and `workspace-repo-status-batch.service.ts` short-circuit
-- on `!== null`), and `hasNonEmptyDiffStats` / `projectDiffStats` treat a null `files_changed`
-- as "no stats yet". So no read needs a `coalesce`, and therefore none needs `.mapWith(...)`
-- either -- there is no raw `sql` expression here to bypass a column's mode mapping, which is
-- the trap 0141 had to handle for `summary_dirty`. The LEFT JOIN is still load-bearing: an
-- inner join would drop every never-diffed workspace off the board.
--
-- Coupling re-derived on the snake_case column names AND the camelCase Drizzle fields, prose
-- mentions discounted. Ten files name the columns/fields against the table: the schema, eight
-- repositories (`issue`, `project-service`, `showdown`, `workspace-reads`,
-- `workspace-repo-status-batch`, `workspace-risk`, `workspace-summary-projection`,
-- `workspace-summary`) and one inline `db.select` in `startup/monitor-setup.ts`. The sole
-- writer, `updateWorkspaceDiffStatCache`, moves to its own owner file
-- `repositories/diff-stat-cache.repository.ts` exactly as `updateWorkspaceConflictCache` did
-- in 0139, so its two service callers change an import and the value-object key names.
-- Everything downstream reads STRUCTURAL row types (`DiffStatCacheFields`,
-- `WorkspaceDetailRow`, `RiskWorkspaceRow`) fed by reads that alias the new columns back to
-- the old `diffStatCache*` field names, so the services, the DTOs and the whole client are
-- untouched.
--
-- `workspace_id` is the PRIMARY KEY and declares its FK with ON DELETE CASCADE: a parent-id
-- column without a declared FK is invisible to the cascade gates (#948), and the PK's automatic
-- index satisfies the FK-leading-index ratchet (#740).
CREATE TABLE `workspace_diff_stat_cache` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`checked_at` text,
	`head_sha` text,
	`files_changed` integer,
	`insertions` integer,
	`deletions` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Backfill BEFORE the drop, in the same migration. Only rows that actually carry a memo are
-- copied: a workspace with all five columns NULL has never been diffed, and "no row" says
-- exactly that, so inserting an all-NULL row would add a row that means nothing.
INSERT INTO `workspace_diff_stat_cache`
	(`workspace_id`, `checked_at`, `head_sha`, `files_changed`, `insertions`, `deletions`)
SELECT
	`id`,
	`diff_stat_cache_checked_at`,
	`diff_stat_cache_head_sha`,
	`diff_stat_cache_files_changed`,
	`diff_stat_cache_insertions`,
	`diff_stat_cache_deletions`
FROM `workspaces`
WHERE `diff_stat_cache_checked_at` IS NOT NULL
	OR `diff_stat_cache_head_sha` IS NOT NULL
	OR `diff_stat_cache_files_changed` IS NOT NULL
	OR `diff_stat_cache_insertions` IS NOT NULL
	OR `diff_stat_cache_deletions` IS NOT NULL;
--> statement-breakpoint
-- Dropped in the SAME migration: a facade would leave two sources of truth and a duplicated
-- write path, which is worse than either alternative (#781 DoD 3). None of these five columns
-- carries an index, so the drop is in-place and FK-clean (libsql ships SQLite 3.45.1).
ALTER TABLE `workspaces` DROP COLUMN `diff_stat_cache_checked_at`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `diff_stat_cache_head_sha`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `diff_stat_cache_files_changed`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `diff_stat_cache_insertions`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `diff_stat_cache_deletions`;