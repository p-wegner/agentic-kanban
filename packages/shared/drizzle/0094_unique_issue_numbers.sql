DROP INDEX `idx_issues_project_id_issue_number`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_issues_project_id_issue_number` ON `issues` (`project_id`,`issue_number`);
