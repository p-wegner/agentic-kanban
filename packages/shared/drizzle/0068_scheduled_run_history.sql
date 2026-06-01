CREATE TABLE `scheduled_run_history` (
	`id` text PRIMARY KEY NOT NULL,
	`scheduled_run_id` text NOT NULL,
	`project_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`triggered_by` text DEFAULT 'manual' NOT NULL,
	`issue_id` text,
	`workspace_id` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`scheduled_run_id`) REFERENCES `scheduled_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_run_history_run_started_at` ON `scheduled_run_history` (`scheduled_run_id`, `started_at`);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_run_history_project_started_at` ON `scheduled_run_history` (`project_id`, `started_at`);
