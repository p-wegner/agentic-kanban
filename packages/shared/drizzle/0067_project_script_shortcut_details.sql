ALTER TABLE `project_script_shortcuts` ADD `description` text;
--> statement-breakpoint
ALTER TABLE `project_script_shortcuts` ADD `cwd_mode` text DEFAULT 'project' NOT NULL;
--> statement-breakpoint
UPDATE `project_script_shortcuts`
SET `cwd_mode` = 'custom'
WHERE `working_dir` IS NOT NULL AND trim(`working_dir`) != '';
