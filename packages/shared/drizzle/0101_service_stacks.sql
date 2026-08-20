ALTER TABLE `projects` ADD COLUMN `services_config` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD COLUMN `service_state` text;