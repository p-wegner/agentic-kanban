-- #798: extract the THIRD column family out of `workspaces` (after `merge_backoff_*` in
-- #781 and `review_preflight_*` in 0134).
--
-- `code_metrics_*` (2 columns) -> `workspace_code_metrics`, keyed by `workspace_id`.
--
-- #739 listed this family at 14 non-test files and ordered it seventh. Re-derived on the
-- actual column names and their camelCase Drizzle fields, the true count is THREE:
-- `repositories/workspace-code-metrics.repository.ts` (the writer),
-- `repositories/workspace-summary.repository.ts` (the read), and the schema. The rest of
-- #739's 14 are substring hits on PROSE — `mcp-server/src/tools/get-board-status.ts` and
-- `repositories/board-status.repository.ts` both name `code_metrics_json` in a COMMENT, as
-- the example of a fat column those queries deliberately do not select. That makes this the
-- cheapest remaining family, not the seventh, which is the same class of error #781 found in
-- #739's `merge_backoff_*` count.
--
-- `services/workspace-summary.service.ts` does read `codeMetricsJson`, but off the projected
-- ROW shape rather than off the table — so the read above aliases the two new columns back to
-- the old field names and that consumer is untouched by the move.
--
-- One row per workspace, written on the first computation. A workspace whose metrics were
-- never computed now stores nothing, where before every row paid two columns — one of them a
-- multi-KB JSON blob — on the board's hottest table.
--
-- `workspace_id` is the PRIMARY KEY and declares its FK with ON DELETE CASCADE: a parent-id
-- column without a declared FK is invisible to the cascade gates (#948), and the PK's
-- automatic index satisfies the FK-leading-index ratchet (#740).
CREATE TABLE `workspace_code_metrics` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`metrics_json` text,
	`computed_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Backfilled anyway, even though a code-metrics artifact is RECOMPUTABLE and #781's ordering
-- notes call the caches "no backfill needed". Recomputable is not free here: `computed_at` is
-- the staleness stamp that decides whether a recompute is scheduled at all, so dropping the
-- rows would schedule a metrics run for every workspace that had one — a thundering herd on
-- the first board load after the migration, to reproduce data that was already on disk.
INSERT INTO `workspace_code_metrics` (`workspace_id`, `metrics_json`, `computed_at`)
SELECT `id`, `code_metrics_json`, `code_metrics_computed_at`
FROM `workspaces`
WHERE `code_metrics_json` IS NOT NULL OR `code_metrics_computed_at` IS NOT NULL;
--> statement-breakpoint
-- Dropped in the SAME migration: a facade would leave two sources of truth and a duplicated
-- write path, which is worse than either alternative (#781 DoD 3). #739 measured DROP COLUMN
-- as in-place and FK-clean here (libsql ships SQLite 3.45.1); neither of these two columns
-- carries an index.
ALTER TABLE `workspaces` DROP COLUMN `code_metrics_json`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `code_metrics_computed_at`;
