CREATE TABLE `milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`due_date` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_milestones_project_id` on `milestones` (`project_id`);
--> statement-breakpoint
ALTER TABLE `issues` ADD `milestone_id` text REFERENCES `milestones`(`id`);
--> statement-breakpoint
CREATE INDEX `idx_issues_milestone_id` on `issues` (`milestone_id`);
