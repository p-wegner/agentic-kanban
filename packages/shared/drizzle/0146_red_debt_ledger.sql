CREATE TABLE `red_debt` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`suite` text NOT NULL,
	`since_commit` text NOT NULL,
	`attributed_issue_id` text,
	`owner_issue_id` text,
	`tag` text NOT NULL,
	`opened_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_red_debt_project_suite` ON `red_debt` (`project_id`,`suite`);
--> statement-breakpoint
CREATE INDEX `idx_red_debt_project_resolved` ON `red_debt` (`project_id`,`resolved_at`);
