CREATE TABLE `workers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`os` text,
	`arch` text,
	`labels` text,
	`providers` text,
	`max_concurrency` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'online' NOT NULL,
	`token_hash` text NOT NULL,
	`last_heartbeat_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_workers_status` ON `workers` (`status`);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `worker_id` text;
