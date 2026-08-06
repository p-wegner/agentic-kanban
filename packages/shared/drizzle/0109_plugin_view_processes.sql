CREATE TABLE `plugin_view_processes` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_row_id` text NOT NULL,
	`view_id` text NOT NULL,
	`project_id` text NOT NULL,
	`pid` integer NOT NULL,
	`port` integer NOT NULL,
	`command` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_plugin_view_processes_key` ON `plugin_view_processes` (`plugin_row_id`,`view_id`,`project_id`);
