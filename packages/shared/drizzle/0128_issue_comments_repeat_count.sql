-- #738: `issue_comments` had no dedup of any kind. 99,797 rows on the live board carry only
-- 1,454 distinct bodies, and 97,798 of them are IDENTICAL to the row immediately before them
-- in the same (issue, kind, workspace) thread — a machine re-posting a state it had already
-- reported. #737 fixed the loudest such producer; these two columns make the collapse a
-- property of the TABLE instead of a habit of one caller.
--
-- `repeat_count` is why this is a collapse and not a drop: the fact that a state was observed
-- N times is real information, and keeping it in one row means it survives without N rows.
-- `last_repeated_at` is when it was last re-observed; NULL means it never repeated, so
-- `created_at` is still the only timestamp for the overwhelming majority of rows.
--
-- No new index. The dedup lookup is "newest row in this issue's thread", which
-- `idx_issue_comments_issue_id_created_at` already serves walking backwards — it stops at the
-- first row and normally does not read a second. A (issue_id, kind, workspace_id, created_at)
-- index would cost ~5 MB on this table to save nothing measurable, in a ticket about size.
ALTER TABLE `issue_comments` ADD `repeat_count` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `issue_comments` ADD `last_repeated_at` text;
