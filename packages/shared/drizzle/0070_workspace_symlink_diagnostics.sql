ALTER TABLE `workspaces` ADD `latest_symlink_state` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `latest_symlink_started_at` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `latest_symlink_ended_at` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `latest_symlink_dirs` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `latest_symlink_linked` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `latest_symlink_skipped` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `latest_symlink_failed` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `latest_symlink_error` text;
