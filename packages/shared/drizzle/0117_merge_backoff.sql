ALTER TABLE `workspaces` ADD `merge_backoff_failures` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `merge_backoff_signature` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `merge_backoff_error` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `merge_backoff_branch_sha` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `merge_backoff_verify_hash` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `merge_backoff_next_retry_at` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `merge_backoff_since` text;
