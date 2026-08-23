-- #798 (the remaining families of #739, after #781): extract the SECOND column family out
-- of `workspaces`.
--
-- `review_preflight_*` (4 columns) — the stranded-review reconciler's rebase-preflight
-- backoff (#283) — goes to `workspace_review_preflight`, keyed by `workspace_id`.
--
-- Why this one next: it is the cheapest remaining family by COUPLING, which #781 established
-- is the ordering that matters rather than column count. Exactly two non-test files name
-- these columns — this schema and `packages/server/src/startup/stranded-review-reconciler.ts`
-- — confirming #739's count of 2 for this family (a grep also hits
-- `shared/src/schema/drive-obstacles.ts`, but only on the obstacle KIND string
-- `"review_preflight_conflict"`, never on a column).
--
-- Unlike `merge_backoff_*`, this family had NO repository: the reconciler wrote the four
-- columns inline with `database.update(workspaces).set({...})` on a live startup path. The
-- extraction introduces `review-preflight.repository.ts` as the seam, which is the part of
-- this change worth having independently of the table width.
--
-- One row per workspace, written lazily on the first preflight failure and deleted when the
-- block clears — so a workspace that never conflicted on rebase stores nothing, instead of
-- paying four columns on the board's hottest table.
--
-- `workspace_id` is the PRIMARY KEY and declares its FK to `workspaces` with ON DELETE
-- CASCADE, for the same two reasons as 0131: a parent-id column without a declared FK is
-- invisible to the cascade gates (#948), and the PK's automatic index is what satisfies the
-- FK-leading-index ratchet (#740).
CREATE TABLE `workspace_review_preflight` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`error` text,
	`signature` text,
	`blocked_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Backfill BEFORE the drop, in the same migration. A workspace carrying a non-default value
-- in any of the four columns gets a row; one holding nothing but the defaults
-- (failures = 0, everything else NULL) gets none — that is the same state the LEFT JOIN
-- reads reconstruct from a missing row, so nothing is lost by omitting it. This matters even
-- though the family is "just backoff": losing it would un-block every workspace the
-- reconciler had given up on, and the next cycle would re-run the most expensive git
-- operation the board runs on each of them, which is exactly the incident #283 fixed.
INSERT INTO `workspace_review_preflight`
	(`workspace_id`, `failures`, `error`, `signature`, `blocked_at`)
SELECT
	`id`,
	COALESCE(`review_preflight_failures`, 0),
	`review_preflight_error`,
	`review_preflight_signature`,
	`review_preflight_blocked_at`
FROM `workspaces`
WHERE COALESCE(`review_preflight_failures`, 0) <> 0
	OR `review_preflight_error` IS NOT NULL
	OR `review_preflight_signature` IS NOT NULL
	OR `review_preflight_blocked_at` IS NOT NULL;
--> statement-breakpoint
-- Dropped in the SAME migration, on purpose: a facade would leave two sources of truth and a
-- duplicated write path, which is worse than either alternative (#781 DoD 3). #739 measured
-- that DROP COLUMN is safe here — libsql ships SQLite 3.45.1, so it is in-place with no table
-- rebuild, and `PRAGMA foreign_key_check` reports 0 violations afterwards despite the 8
-- inbound FKs. None of these four columns carries an index (only `showdown_id` and
-- `parent_workspace_id` do, and neither is touched).
ALTER TABLE `workspaces` DROP COLUMN `review_preflight_failures`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `review_preflight_error`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `review_preflight_signature`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `review_preflight_blocked_at`;
