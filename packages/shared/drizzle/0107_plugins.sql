CREATE TABLE `plugins` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`name` text NOT NULL,
	`source_url` text,
	`local_path` text NOT NULL,
	`version` text,
	`manifest_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_plugins_plugin_id` ON `plugins` (`plugin_id`);
