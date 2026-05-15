CREATE TABLE `issue_dependencies` (
  `id` text PRIMARY KEY NOT NULL,
  `issue_id` text NOT NULL,
  `depends_on_id` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`depends_on_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_dependencies_unique` ON `issue_dependencies` (`issue_id`,`depends_on_id`);
