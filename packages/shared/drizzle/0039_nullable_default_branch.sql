PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `projects_new` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`color` text,
	`repo_path` text DEFAULT '' NOT NULL,
	`repo_name` text DEFAULT '' NOT NULL,
	`default_branch` text,
	`remote_url` text,
	`setup_script` text,
	`setup_blocking` integer DEFAULT 1 NOT NULL,
	`setup_enabled` integer DEFAULT 1 NOT NULL,
	`teardown_script` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `projects_new` (
	`id`,
	`name`,
	`description`,
	`color`,
	`repo_path`,
	`repo_name`,
	`default_branch`,
	`remote_url`,
	`setup_script`,
	`setup_blocking`,
	`setup_enabled`,
	`teardown_script`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`name`,
	`description`,
	`color`,
	`repo_path`,
	`repo_name`,
	`default_branch`,
	`remote_url`,
	`setup_script`,
	`setup_blocking`,
	`setup_enabled`,
	`teardown_script`,
	`created_at`,
	`updated_at`
FROM `projects`;
--> statement-breakpoint
DROP TABLE `projects`;
--> statement-breakpoint
ALTER TABLE `projects_new` RENAME TO `projects`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
