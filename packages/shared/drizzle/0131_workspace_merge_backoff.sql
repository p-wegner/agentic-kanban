-- #781 (the remainder of #739): extract the FIRST column family out of `workspaces`.
--
-- #739 measured `workspaces` at 88 columns against a live DB of 659 rows. The next widest
-- table in this schema has 23 and the median across 44 tables is 9, so this is not "a wide
-- table" — it is eleven separate concerns flattened into one row by prefix, 55 of the 88
-- columns. #739 landed the shrink-only ratchet and deliberately left the extraction.
--
-- `merge_backoff_*` (7 columns) goes first because it has the best ratio of size to blast
-- radius: every read and write already went through ONE repository
-- (`packages/server/src/repositories/merge-backoff.repository.ts`), whose only consumer is
-- `merge-backoff.service.ts`. No other non-test file in the repo names these columns —
-- verified by grep, which also refutes #739's own count of 3 files: `startup/monitor-cycle.ts`
-- matched only on the identifier `mergeBackoffDeps` (deps wiring), never on a column.
-- `review_preflight_*` is smaller (4 columns) but its columns are read and written inline in
-- `startup/stranded-review-reconciler.ts` with no repository seam, so it is the more invasive
-- first cut, not the cheaper one.
--
-- One row per workspace, written lazily on the first merge failure and deleted when the block
-- clears — so a workspace that never failed a merge now stores nothing, instead of paying
-- seven columns on the board's hottest table.
--
-- `workspace_id` is the PRIMARY KEY and declares its FK to `workspaces` with ON DELETE
-- CASCADE. Both are required, not stylistic: a parent-id column without a declared FK is
-- invisible to the cascade gates (#948, and 0130 which had to rebuild 0129's table for
-- exactly this), and the PK's automatic index is what satisfies the FK-leading-index
-- ratchet (#740).
CREATE TABLE `workspace_merge_backoff` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`signature` text,
	`error` text,
	`branch_sha` text,
	`verify_hash` text,
	`next_retry_at` text,
	`since` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Backfill BEFORE the drop, in the same migration: any workspace that carries a non-default
-- value in any of the seven columns gets a row. A workspace with nothing but the defaults
-- (failures = 0, everything else NULL) gets none — that is the same state the reads now
-- reconstruct from the LEFT JOIN, so no information is lost by omitting it.
INSERT INTO `workspace_merge_backoff`
	(`workspace_id`, `failures`, `signature`, `error`, `branch_sha`, `verify_hash`, `next_retry_at`, `since`)
SELECT
	`id`,
	COALESCE(`merge_backoff_failures`, 0),
	`merge_backoff_signature`,
	`merge_backoff_error`,
	`merge_backoff_branch_sha`,
	`merge_backoff_verify_hash`,
	`merge_backoff_next_retry_at`,
	`merge_backoff_since`
FROM `workspaces`
WHERE COALESCE(`merge_backoff_failures`, 0) <> 0
	OR `merge_backoff_signature` IS NOT NULL
	OR `merge_backoff_error` IS NOT NULL
	OR `merge_backoff_branch_sha` IS NOT NULL
	OR `merge_backoff_verify_hash` IS NOT NULL
	OR `merge_backoff_next_retry_at` IS NOT NULL
	OR `merge_backoff_since` IS NOT NULL;
--> statement-breakpoint
-- Dropped in the SAME migration, on purpose. Keeping them as a facade would leave two
-- sources of truth and a duplicated write path, which is worse than either alternative
-- (#781's definition of done, point 3). #739 measured that this is safe here: libsql ships
-- SQLite 3.45.1, so DROP COLUMN is in-place with no table rebuild, `PRAGMA foreign_key_check`
-- reports 0 violations afterwards despite the 8 inbound FKs, and none of these seven columns
-- carries an index (only `showdown_id` and `parent_workspace_id` do, and neither is touched).
ALTER TABLE `workspaces` DROP COLUMN `merge_backoff_failures`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `merge_backoff_signature`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `merge_backoff_error`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `merge_backoff_branch_sha`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `merge_backoff_verify_hash`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `merge_backoff_next_retry_at`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `merge_backoff_since`;
