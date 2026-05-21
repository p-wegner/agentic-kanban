CREATE TABLE `scheduled_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`project_id` text NOT NULL REFERENCES `projects`(`id`),
	`prompt` text,
	`skill_id` text REFERENCES `agent_skills`(`id`),
	`interval_minutes` integer NOT NULL DEFAULT 60,
	`enabled` integer NOT NULL DEFAULT 1,
	`system_issue_id` text,
	`last_run_at` text,
	`last_run_status` text,
	`last_run_workspace_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
