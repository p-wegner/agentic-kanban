CREATE TABLE `agent_skills_new` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `description` text NOT NULL,
  `prompt` text NOT NULL,
  `model` text,
  `project_id` text REFERENCES `projects`(`id`),
  `is_builtin` integer DEFAULT 0 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `agent_skills_new` SELECT `id`, `name`, `description`, `prompt`, `model`, NULL, `is_builtin`, `created_at`, `updated_at` FROM `agent_skills`;
--> statement-breakpoint
DROP TABLE `agent_skills`;
--> statement-breakpoint
ALTER TABLE `agent_skills_new` RENAME TO `agent_skills`;
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_skills_name_scope_unique` ON `agent_skills` (`name`, `project_id`);
