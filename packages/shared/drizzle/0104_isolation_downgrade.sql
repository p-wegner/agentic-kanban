ALTER TABLE `workspaces` ADD `isolation_downgraded` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `isolation_downgrade_reason` text;
