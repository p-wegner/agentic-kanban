CREATE INDEX idx_issues_project_id ON issues(project_id);
--> statement-breakpoint
CREATE INDEX idx_issues_status_id ON issues(status_id);
--> statement-breakpoint
CREATE INDEX idx_workspaces_issue_id ON workspaces(issue_id);
--> statement-breakpoint
CREATE INDEX idx_sessions_workspace_id ON sessions(workspace_id);
--> statement-breakpoint
CREATE INDEX idx_issue_deps_issue_id ON issue_dependencies(issue_id);
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN conflict_cache_checked_at TEXT;
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN conflict_cache_has_conflicts INTEGER;
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN conflict_cache_files TEXT;
