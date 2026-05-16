CREATE TABLE `agent_skills` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL UNIQUE,
  `description` text NOT NULL,
  `prompt` text NOT NULL,
  `model` text,
  `is_builtin` integer DEFAULT 0 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
