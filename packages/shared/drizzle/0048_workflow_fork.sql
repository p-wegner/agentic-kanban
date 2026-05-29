ALTER TABLE `workspaces` ADD `parent_workspace_id` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `fork_node_id` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `fork_join_node_id` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `fork_status` text;
--> statement-breakpoint
CREATE INDEX `idx_workspaces_parent_workspace_id` ON `workspaces` (`parent_workspace_id`);
