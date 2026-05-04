CREATE TABLE `diff_comments` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `file_path` text NOT NULL,
  `line_num_old` integer,
  `line_num_new` integer,
  `side` text DEFAULT 'new' NOT NULL,
  `body` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
