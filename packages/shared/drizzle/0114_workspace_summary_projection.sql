-- #399 — workspace-summary git projection (docs/decisions/014). The two phase-4 git
-- facts (git log -1, git rev-list --count) persist on the workspace row so board reads
-- are a pure SELECT; board events mark rows dirty and a bounded heal pass refreshes them.
-- summary_dirty defaults to 1 so every pre-0114 row is refreshed on first sight.
ALTER TABLE `workspaces` ADD `summary_head_sha` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `summary_head_message` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `summary_commit_count` integer;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `summary_git_refreshed_at` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `summary_dirty` integer DEFAULT 1 NOT NULL;
