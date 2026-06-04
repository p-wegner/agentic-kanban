CREATE INDEX `idx_issues_status_id_status_changed_at` ON `issues` (`status_id`,`status_changed_at`);
--> statement-breakpoint
CREATE INDEX `idx_issues_project_id_status_id_status_changed_at` ON `issues` (`project_id`,`status_id`,`status_changed_at`);
