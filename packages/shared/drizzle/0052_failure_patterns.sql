CREATE TABLE `failure_patterns` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`error_class` text,
	`keywords` text NOT NULL DEFAULT '',
	`description` text,
	`root_cause` text,
	`fix` text,
	`source_type` text NOT NULL DEFAULT 'learning',
	`source_ref` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_failure_patterns_error_class` ON `failure_patterns` (`error_class`);
--> statement-breakpoint
CREATE INDEX `idx_failure_patterns_source_type` ON `failure_patterns` (`source_type`);
