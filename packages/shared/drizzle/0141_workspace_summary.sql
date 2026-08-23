-- #815: extract the EIGHTH column family out of `workspaces` (after `merge_backoff_*` in
-- #781, `review_preflight_*` / `code_metrics_*` / `latest_symlink_*` in #798, and
-- `merge_gate_*` in 0138 / `conflict_cache_*` in 0139 / `latest_setup_*` in 0140).
--
-- `summary_*` (5 columns) -> `workspace_summary`, keyed by `workspace_id`.
--
-- WHAT THESE COLUMNS ARE: the workspace-summary GIT PROJECTION (#399, decision 014, migration
-- 0114) -- `git log -1` sha + subject, `git rev-list --count base..HEAD`, a freshness stamp
-- and a dirty flag, persisted so the board's hot read never spawns git. `summary_head_message`
-- is a free-text commit subject, which is exactly the fat-column shape two comments elsewhere
-- in this codebase cite as the reason their queries skip columns.
--
-- THE INVERSION THIS FAMILY CARRIES. `summary_dirty` was `NOT NULL DEFAULT TRUE`, so unlike the
-- seven landed families an ABSENT ROW IS NOT THE NEUTRAL VALUE: no row must read as DIRTY, not
-- as clean. Every read therefore coalesces -- `fetchWorkspaceDetailRows` selects
-- `coalesce(dirty, 1)`, and `selectSummaryHealCandidates` coalesces in BOTH its WHERE and its
-- ORDER BY. The ORDER BY is the one that would have failed silently: SQLite sorts NULL LAST
-- under DESC, so an un-coalesced `ORDER BY dirty DESC` would have ranked never-projected
-- workspaces below dirty ones instead of alongside them.
--
-- The write side needs no upsert for the flag BECAUSE of that inversion: marking dirty is a
-- plain UPDATE, and a workspace with no row is a no-op that is already dirty by absence. Only
-- the write-through refresh -- the one writer that can make a projection CLEAN -- upserts.
--
-- Coupling re-derived on the column names AND the camelCase Drizzle fields. The ticket said
-- "5 name the column; 4 more read a projected row", and that is exactly right for the
-- workspaces half: `schema/workspaces.ts`, `shared/lib/workspace-status.ts` (the status-write
-- authority's dirty stamp), `repositories/workspace-merge-execution.repository.ts` (the merge
-- stamp), `repositories/workspace-summary-projection.repository.ts` (write-through, dirty
-- mark, heal-candidate select) and `repositories/workspace-summary.repository.ts` (the hot
-- board read). The consumers -- `services/workspace-summary.service.ts`,
-- `services/workspace-summary-projection.service.ts`,
-- `services/workspace-repo-status-batch.service.ts`, `services/workspace-all-repos.ts` -- read
-- STRUCTURAL row types (`GitProjectionFreshnessFields`, `GitProjectionTarget`,
-- `WorkspaceDetailRow`) fed by that read, which aliases the new columns back to the old
-- `summary*` field names, so they and the DTO and the whole client are untouched.
--
-- WHAT DELIBERATELY DOES NOT MOVE: `repos` carries its OWN parallel `summary_*` block
-- (`summary_ahead`, `summary_historic`, `summary_git_refreshed_at`, `summary_dirty`, migration
-- 0118) and stays inline. The two halves share a naming convention, not a mechanism: different
-- column sets, different freshness predicates, separate heal passes and separate candidate
-- queries. `repos` is 23 columns wide and carries no width ratchet, so it is not the table this
-- extraction exists to relieve.
--
-- `workspace_id` is the PRIMARY KEY and declares its FK with ON DELETE CASCADE: a parent-id
-- column without a declared FK is invisible to the cascade gates (#948), and the PK's automatic
-- index satisfies the FK-leading-index ratchet (#740).
CREATE TABLE `workspace_summary` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`head_sha` text,
	`head_message` text,
	`commit_count` integer,
	`git_refreshed_at` text,
	`dirty` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Backfill BEFORE the drop, in the same migration. Every existing workspace carries a
-- projection state (`summary_dirty` is NOT NULL), so unlike the sparse cache families this
-- copies EVERY row: skipping the all-default ones would be correct for the four nullable
-- facts but would silently turn a stored `dirty = 0` (a clean, freshly refreshed projection)
-- into "absent, therefore dirty" and re-spawn git for it on the next board build.
INSERT INTO `workspace_summary`
	(`workspace_id`, `head_sha`, `head_message`, `commit_count`, `git_refreshed_at`, `dirty`)
SELECT
	`id`,
	`summary_head_sha`,
	`summary_head_message`,
	`summary_commit_count`,
	`summary_git_refreshed_at`,
	`summary_dirty`
FROM `workspaces`;
--> statement-breakpoint
-- Dropped in the SAME migration: a facade would leave two sources of truth and a duplicated
-- write path, which is worse than either alternative (#781 DoD 3). None of these five columns
-- carries an index, so the drop is in-place and FK-clean (libsql ships SQLite 3.45.1).
ALTER TABLE `workspaces` DROP COLUMN `summary_head_sha`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `summary_head_message`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `summary_commit_count`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `summary_git_refreshed_at`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `summary_dirty`;