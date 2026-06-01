ALTER TABLE `projects` ADD `symlink_enabled` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `projects` ADD `symlink_dirs` text;
