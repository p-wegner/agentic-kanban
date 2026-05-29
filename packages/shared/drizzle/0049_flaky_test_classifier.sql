CREATE TABLE `flaky_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`test_name` text NOT NULL,
	`test_file_path` text,
	`error_pattern` text,
	`reason` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_flaky_tests_project_id` ON `flaky_tests` (`project_id`);
--> statement-breakpoint
CREATE TABLE `test_retry_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`test_name` text NOT NULL,
	`decision` text NOT NULL,
	`confidence` real NOT NULL,
	`retry_count` integer NOT NULL DEFAULT 0,
	`final_outcome` text NOT NULL DEFAULT 'pending',
	`classifier_input` text,
	`reasoning` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_test_retry_decisions_session_id` ON `test_retry_decisions` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_test_retry_decisions_workspace_id` ON `test_retry_decisions` (`workspace_id`);
--> statement-breakpoint
ALTER TABLE `projects` ADD `auto_retry_flakes` integer DEFAULT true;
--> statement-breakpoint
ALTER TABLE `projects` ADD `max_retries` integer DEFAULT 2;
