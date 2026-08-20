CREATE TABLE `plugin_loop_events` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_slug` text NOT NULL,
	`loop_name` text NOT NULL,
	`project_id` text NOT NULL,
	`type` text NOT NULL,
	`payload_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_plugin_loop_events_loop` ON `plugin_loop_events` (`plugin_slug`,`loop_name`,`project_id`,`created_at`);
