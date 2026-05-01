CREATE TABLE `preferences` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `repo_path` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `repo_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `default_branch` text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `remote_url` text;