-- #415 — extend the #399 workspace-summary projection (decision 014) to the `repos`-table
-- rows, so repo-merge-status answers from persisted facts with ZERO git spawns when fresh.
-- Per workspace-scoped repo row (leading AND sibling):
--   summary_ahead     = commits on the repo's branch not on its base branch (the "ahead" fact)
--   summary_historic  = commits between the original cut point and the branch tip when
--                       ahead is 0 (the "had work, now landed" fact)
-- Both facts together derive hasWork/merged/stranded exactly as the live computation does.
-- summary_dirty defaults to 1 so every pre-0118 row is refreshed on first sight; the same
-- board events that dirty the workspace projection dirty these rows, and the same bounded
-- 5-minute heal pass refreshes them. Conflicts stay live/SWR (decision 014's boundary).
ALTER TABLE `repos` ADD `summary_ahead` integer;--> statement-breakpoint
ALTER TABLE `repos` ADD `summary_historic` integer;--> statement-breakpoint
ALTER TABLE `repos` ADD `summary_git_refreshed_at` text;--> statement-breakpoint
ALTER TABLE `repos` ADD `summary_dirty` integer DEFAULT 1 NOT NULL;
