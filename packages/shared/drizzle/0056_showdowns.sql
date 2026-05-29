CREATE TABLE `showdowns` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL REFERENCES `issues`(`id`),
	`status` text NOT NULL DEFAULT 'active',
	`winner_workspace_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `showdown_id` text REFERENCES `showdowns`(`id`);
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `showdown_label` text;
--> statement-breakpoint
CREATE INDEX `idx_showdowns_issue_id` ON `showdowns` (`issue_id`);
--> statement-breakpoint
CREATE INDEX `idx_workspaces_showdown_id` ON `workspaces` (`showdown_id`);
