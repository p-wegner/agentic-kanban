-- #815: extract the TENTH and LAST in-scope column family out of `workspaces` (after
-- `merge_backoff_*` in #781, `review_preflight_*` / `code_metrics_*` / `latest_symlink_*` in
-- #798, and `merge_gate_*` in 0138 / `conflict_cache_*` in 0139 / `latest_setup_*` in 0140 /
-- `summary_*` in 0141 / `diff_stat_cache_*` in 0142).
--
-- `scorecard_*` (3 columns) -> `workspace_scorecard`, keyed by `workspace_id`.
--
-- WHAT THESE COLUMNS ARE: the computed PR-quality scorecard -- a 0-100 total, the JSON array of
-- per-dimension breakdowns it was derived from (Tests, Types, Scope, Diff size, Conflicts,
-- Docs, Skill output), and the stamp saying when it was computed. Structurally the same shape
-- as `workspace_code_metrics` (#798): a computed ARTIFACT, not a fact about the workspace.
-- `scorecard_json` is a free-text blob, which is why this family was sequenced last rather
-- than dropped -- it is the fat column the board's own comments cite as the reason its hot
-- queries skip columns.
--
-- ABSENCE IS THE NEUTRAL VALUE, as it was for 0142 and unlike `summary_dirty` in 0141. All
-- three columns were nullable with no default, and every consumer already branches on
-- `scorecardScore === null` ("Scorecard not yet computed for this workspace"). An absent row
-- reproduces that exactly, so no read coalesces and none needs `.mapWith(...)`. The one read
-- that FILTERED on the column -- `getScorecardScores`, the histogram -- now selects FROM this
-- table with its `IS NOT NULL` intact: a workspace with no row has no score, which is what
-- the filter always meant. The LEFT JOINs elsewhere are load-bearing: an inner join would
-- hide every workspace whose first session has not ended yet, i.e. most of the board.
--
-- Coupling re-derived on the snake_case column names AND the camelCase Drizzle fields, prose
-- mentions discounted, and -- after 0142's under-count -- also on `select()`-everything rows,
-- which no grep on the table name can see. Nine files name the family: the schema, six
-- repositories (`issue`, `review-effectiveness`, `workspace-analytics`, `workspace-reads`,
-- `workspace-scorecard`, `workspace-summary`) and two mcp-server tools
-- (`get-workspace-scorecard`, `session-review-effectiveness`). mcp-server cannot import server
-- code, so those two write their join inline. Everything downstream reads STRUCTURAL row types
-- (`WorkspaceDetailRow`, the `review-effectiveness-aggregation` shapes) fed by reads that alias
-- the new columns back to the old `scorecard*` field names, so the services, the DTOs and the
-- whole client are untouched.
--
-- `workspace_id` is the PRIMARY KEY and declares its FK with ON DELETE CASCADE: a parent-id
-- column without a declared FK is invisible to the cascade gates (#948), and the PK's automatic
-- index satisfies the FK-leading-index ratchet (#740).
CREATE TABLE `workspace_scorecard` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`score` integer,
	`json` text,
	`computed_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Backfill BEFORE the drop, in the same migration. Only rows that actually carry a scorecard
-- are copied: a workspace with all three columns NULL has never been scored, and "no row" says
-- exactly that. `IS NOT NULL`, not a truthiness test -- a score of 0 is a real (terrible)
-- scorecard, and `0` is falsy.
INSERT INTO `workspace_scorecard`
	(`workspace_id`, `score`, `json`, `computed_at`)
SELECT
	`id`,
	`scorecard_score`,
	`scorecard_json`,
	`scorecard_computed_at`
FROM `workspaces`
WHERE `scorecard_score` IS NOT NULL
	OR `scorecard_json` IS NOT NULL
	OR `scorecard_computed_at` IS NOT NULL;
--> statement-breakpoint
-- Dropped in the SAME migration: a facade would leave two sources of truth and a duplicated
-- write path, which is worse than either alternative (#781 DoD 3). None of these three columns
-- carries an index, so the drop is in-place and FK-clean (libsql ships SQLite 3.45.1).
ALTER TABLE `workspaces` DROP COLUMN `scorecard_score`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `scorecard_json`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `scorecard_computed_at`;