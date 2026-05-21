ALTER TABLE workspaces ADD COLUMN diff_stat_cache_checked_at text;
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN diff_stat_cache_files_changed integer;
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN diff_stat_cache_insertions integer;
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN diff_stat_cache_deletions integer;
