ALTER TABLE `projects` ADD `setup_script` text;
--> statement-breakpoint
ALTER TABLE `projects` ADD `setup_blocking` integer NOT NULL DEFAULT 1;
