CREATE TABLE `drives` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`meta_issue_id` text,
	`target` text NOT NULL,
	`completion_contract` text,
	`status` text DEFAULT 'active' NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`meta_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_drives_project_id` on `drives` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_drives_meta_issue_id` on `drives` (`meta_issue_id`);
