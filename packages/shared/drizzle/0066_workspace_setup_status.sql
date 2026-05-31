ALTER TABLE `workspaces` ADD `latest_setup_command` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `latest_setup_state` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `latest_setup_started_at` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `latest_setup_ended_at` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `latest_setup_exit_code` integer;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `latest_setup_duration_ms` integer;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `latest_setup_stdout_tail` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `latest_setup_stderr_tail` text;
