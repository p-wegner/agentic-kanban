-- #815: extract the SIXTH column family out of `workspaces` (after `merge_backoff_*` in
-- #781, `review_preflight_*` / `code_metrics_*` / `latest_symlink_*` in #798, and
-- `merge_gate_*` in 0138).
--
-- `conflict_cache_*` (3 columns) -> `workspace_conflict_cache`, keyed by `workspace_id`.
--
-- WHAT THESE COLUMNS ARE: a stale-while-revalidate memo of one `git merge-tree` probe --
-- when it ran, whether it conflicted, and which paths. Genuinely a CACHE, rebuildable from
-- git at any moment by `applyConflicts` in `services/workspace-summary.service.ts`. That is
-- the case FOR its own table, not against it: nothing here is a fact about the workspace, it
-- is a memo about a git question carrying its own TTL stamp.
--
-- Rebuildable is NOT retirable (#798's standing rule, settled when `latest_symlink_*` looked
-- retirable and was not). Without the memo every board read re-probes git on the hot path,
-- which is the exact regression #399 / decision 014 exists to prevent. The memo moves; it
-- does not disappear.
--
-- Coupling re-derived on the column names AND the camelCase Drizzle fields. The ticket
-- estimated ~11 files; 5 actually name them against the TABLE:
--   * `schema/workspaces.ts` (the declaration),
--   * `repositories/workspace-summary.repository.ts` (the board read AND the sole writer,
--     `updateWorkspaceConflictCache`),
--   * `repositories/workspace-risk.repository.ts` (the risk-signal read, all three),
--   * `repositories/issue.repository.ts` and `repositories/workspace-reads.repository.ts`
--     (two of the three, for the workspace-details projection).
-- Four more read the fields off a PROJECTED ROW and are untouched because both reads alias
-- the new columns back to `conflictCache*` (`lib/workspace-details-projection.ts`,
-- `lib/workspace-risk-signals.ts`, `services/issue.service.ts`,
-- `services/workspace-summary.service.ts`). Two mention a column only in a comment
-- (`repositories/board-status.repository.ts`, `mcp-server/src/tools/get-board-status.ts`),
-- and two more (`services/board-status.ts`, `services/board-status-enrichment.ts`) hold an
-- unrelated in-memory `conflictCache` Map -- a name collision, not a column reference. That
-- is the prose/collision inflation #798 warned about, counted out.
--
-- ABSENT ROW == never probed, exactly as a NULL `conflict_cache_checked_at` meant: the age
-- computes as Infinity and the revalidation path runs. So the reads LEFT JOIN from
-- `workspaces`; an inner join would hide every never-probed workspace from the board.
--
-- `workspace_id` is the PRIMARY KEY and declares its FK with ON DELETE CASCADE: a parent-id
-- column without a declared FK is invisible to the cascade gates (#948), and the PK's
-- automatic index satisfies the FK-leading-index ratchet (#740).
CREATE TABLE `workspace_conflict_cache` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`checked_at` text,
	`has_conflicts` integer,
	`files` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Backfill BEFORE the drop, in the same migration. The cache could in principle be thrown
-- away and re-probed -- but a cold cache means every board read spawns git until the
-- revalidation catches up, so the memo is carried across rather than discarded.
INSERT INTO `workspace_conflict_cache`
	(`workspace_id`, `checked_at`, `has_conflicts`, `files`)
SELECT
	`id`,
	`conflict_cache_checked_at`,
	`conflict_cache_has_conflicts`,
	`conflict_cache_files`
FROM `workspaces`
WHERE `conflict_cache_checked_at` IS NOT NULL
	OR `conflict_cache_has_conflicts` IS NOT NULL
	OR `conflict_cache_files` IS NOT NULL;
--> statement-breakpoint
-- Dropped in the SAME migration: a facade would leave two sources of truth and a duplicated
-- write path, which is worse than either alternative (#781 DoD 3). None of these three
-- columns carries an index, so the drop is in-place and FK-clean (libsql ships SQLite 3.45.1).
ALTER TABLE `workspaces` DROP COLUMN `conflict_cache_checked_at`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `conflict_cache_has_conflicts`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `conflict_cache_files`;