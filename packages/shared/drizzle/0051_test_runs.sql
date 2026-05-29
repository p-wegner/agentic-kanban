CREATE TABLE `test_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`commit_sha` text,
	`test_name` text NOT NULL,
	`file` text,
	`suite` text,
	`passed` integer NOT NULL,
	`duration_ms` integer,
	`error_message` text,
	`runner` text NOT NULL DEFAULT 'vitest',
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_test_runs_session_id` ON `test_runs` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_test_runs_test_name` ON `test_runs` (`test_name`);
--> statement-breakpoint
CREATE INDEX `idx_test_runs_file` ON `test_runs` (`file`);
--> statement-breakpoint
CREATE TABLE `flaky_test_pins` (
	`test_name` text PRIMARY KEY NOT NULL,
	`file` text,
	`pinned_at` text NOT NULL,
	`pinned_by` text
);
