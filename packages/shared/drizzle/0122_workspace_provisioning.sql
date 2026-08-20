CREATE TABLE `workspace_provisioning` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`project_id` text NOT NULL,
	`branch` text,
	`worktree_path` text,
	`server_pid` integer NOT NULL,
	`phase` text NOT NULL,
	`started_at` text NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_provisioning_issue` ON `workspace_provisioning` (`issue_id`);
