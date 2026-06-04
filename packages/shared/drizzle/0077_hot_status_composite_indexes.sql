CREATE INDEX `idx_issues_project_id_status_id` ON `issues` (`project_id`,`status_id`);
--> statement-breakpoint
CREATE INDEX `idx_workspaces_issue_id_status` ON `workspaces` (`issue_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_sessions_workspace_id_status` ON `sessions` (`workspace_id`,`status`);
