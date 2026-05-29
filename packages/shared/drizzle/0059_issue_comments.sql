CREATE TABLE `issue_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL REFERENCES `issues`(`id`),
	`workspace_id` text REFERENCES `workspaces`(`id`),
	`kind` text NOT NULL,
	`author` text NOT NULL,
	`body` text NOT NULL,
	`payload` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_issue_comments_issue_id` ON `issue_comments` (`issue_id`);
