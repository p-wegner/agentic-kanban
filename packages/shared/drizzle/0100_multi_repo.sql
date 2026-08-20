ALTER TABLE `repos` ADD COLUMN `default_branch` text;
--> statement-breakpoint
ALTER TABLE `repos` ADD COLUMN `worktree_path` text;
--> statement-breakpoint
ALTER TABLE `repos` ADD COLUMN `branch` text;
--> statement-breakpoint
ALTER TABLE `repos` ADD COLUMN `base_branch` text;
--> statement-breakpoint
ALTER TABLE `repos` ADD COLUMN `base_commit_sha` text;
--> statement-breakpoint
ALTER TABLE `repos` ADD COLUMN `merged_head_sha` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `repos_project_id_idx` ON `repos` (`project_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `repos_workspace_id_idx` ON `repos` (`workspace_id`);
