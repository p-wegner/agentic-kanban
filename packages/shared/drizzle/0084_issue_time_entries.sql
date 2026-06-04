CREATE TABLE `issue_time_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`minutes` integer NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_issue_time_entries_issue_id` ON `issue_time_entries` (`issue_id`);
