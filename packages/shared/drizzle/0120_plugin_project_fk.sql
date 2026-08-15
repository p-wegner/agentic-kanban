CREATE TABLE `plugin_view_processes_new` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_row_id` text NOT NULL,
	`view_id` text NOT NULL,
	`project_id` text NOT NULL,
	`pid` integer NOT NULL,
	`port` integer NOT NULL,
	`command` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `plugin_view_processes_new` SELECT * FROM `plugin_view_processes` WHERE `project_id` IN (SELECT `id` FROM `projects`);
--> statement-breakpoint
DROP TABLE `plugin_view_processes`;
--> statement-breakpoint
ALTER TABLE `plugin_view_processes_new` RENAME TO `plugin_view_processes`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_plugin_view_processes_key` ON `plugin_view_processes` (`plugin_row_id`,`view_id`,`project_id`);
