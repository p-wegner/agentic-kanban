CREATE INDEX `idx_issues_project_id_created_at` ON `issues` (`project_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_workspaces_issue_id_created_at` ON `workspaces` (`issue_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_sessions_workspace_id_started_at` ON `sessions` (`workspace_id`,`started_at`);
