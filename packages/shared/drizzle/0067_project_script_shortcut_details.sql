ALTER TABLE `project_script_shortcuts` ADD `description` text;
--> statement-breakpoint
ALTER TABLE `project_script_shortcuts` ADD `cwd_mode` text DEFAULT 'project' NOT NULL;
