CREATE TABLE `drive_obstacles` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`drive_id` text,
	`kind` text NOT NULL,
	`severity` text DEFAULT 'warning' NOT NULL,
	`issue_number` integer,
	`summary` text NOT NULL,
	`details` text,
	`detected_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`drive_id`) REFERENCES `drives`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_drive_obstacles_project_id` on `drive_obstacles` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_drive_obstacles_drive_id` on `drive_obstacles` (`drive_id`);
--> statement-breakpoint
CREATE INDEX `idx_drive_obstacles_kind` on `drive_obstacles` (`kind`);
