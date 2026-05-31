CREATE TABLE `quality_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`metric_key` text NOT NULL,
	`value` real NOT NULL,
	`unit` text,
	`meta` text,
	`collected_at` text NOT NULL,
	`commit_sha` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_quality_metrics_project_metric_collected` ON `quality_metrics` (`project_id`, `metric_key`, `collected_at` DESC);
