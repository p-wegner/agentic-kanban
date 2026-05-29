CREATE TABLE `board_health_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL REFERENCES `projects`(`id`),
	`cycle_id` text NOT NULL,
	`event_type` text NOT NULL,
	`summary` text NOT NULL,
	`details` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_board_health_events_project_id` ON `board_health_events` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_board_health_events_cycle_id` ON `board_health_events` (`cycle_id`);
