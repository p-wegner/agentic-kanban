CREATE TABLE `issue_artifacts` (
  `id` text PRIMARY KEY NOT NULL,
  `issue_id` text NOT NULL REFERENCES `issues`(`id`),
  `workspace_id` text REFERENCES `workspaces`(`id`),
  `type` text NOT NULL,
  `mime_type` text,
  `content` text NOT NULL,
  `caption` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `workspaces` ADD COLUMN `include_visual_proof` integer DEFAULT 0 NOT NULL;
