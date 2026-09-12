-- #1107: `POST /api/issues/:id/tags` had no uniqueness guard, so re-attaching an already-attached
-- tag (which reads as "attach" because reads were blind everywhere except the board endpoint)
-- minted a second `issue_tags` row instead of being idempotent. Measured: #1102 and #1106 both
-- ended at `['no-auto-start','no-auto-start']`.
--
-- Delete-first, keeping the oldest (lexicographically smallest `id`) row per (issue_id, tag_id)
-- pair, so this migration is safe to run against a database that already holds duplicates from
-- before the app-level fix landed. Then enforce the invariant at the DB so it cannot regress
-- even from a caller that bypasses the service layer.
DELETE FROM `issue_tags`
WHERE `id` NOT IN (
	SELECT MIN(`id`) FROM `issue_tags` GROUP BY `issue_id`, `tag_id`
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_issue_tags_issue_tag_unique` ON `issue_tags` (`issue_id`, `tag_id`);
--> statement-breakpoint
-- Redundant now (#813 index-hygiene ratchet): a non-unique index on `(issue_id)` is a strict
-- prefix of the wider unique index just created, which serves every lookup the narrow one did.
DROP INDEX `idx_issue_tags_issue_id`;
