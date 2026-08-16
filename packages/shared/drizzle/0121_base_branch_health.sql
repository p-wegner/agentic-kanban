CREATE TABLE `base_branch_health` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`sha` text NOT NULL,
	`branch` text NOT NULL,
	`outcome` text NOT NULL,
	`duration_ms` integer,
	`message` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_base_branch_health_project_id` ON `base_branch_health` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_base_branch_health_project_sha` ON `base_branch_health` (`project_id`,`sha`);
--> statement-breakpoint
CREATE INDEX `idx_base_branch_health_created_at` ON `base_branch_health` (`created_at`);
