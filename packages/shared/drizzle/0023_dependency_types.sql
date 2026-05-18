ALTER TABLE `issue_dependencies` ADD `type` text DEFAULT 'depends_on' NOT NULL;
--> statement-breakpoint
DROP INDEX `issue_dependencies_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_dependencies_unique` ON `issue_dependencies` (`issue_id`, `depends_on_id`, `type`);
