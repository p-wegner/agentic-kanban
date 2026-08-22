-- #740: 12 of 54 foreign keys had no index leading on the referencing column, so every
-- join or FK-integrity check across one of them was a full table scan. `foreign_keys` is
-- ON, so the cost is paid on writes too: deleting a workspace had to scan all ~100k rows
-- of `issue_comments` to check `workspace_id`.
--
-- Every column below was verified NOT to be the leading column of any existing index
-- (PRAGMA index_list/index_info per table) — none of these is redundant. Three sat in the
-- middle of a composite index, which does not help: `issue_dependencies.depends_on_id`
-- (2nd of the unique edge index), `plugin_loop_events.project_id` (3rd) and
-- `plugin_view_processes.project_id` (3rd).
CREATE INDEX IF NOT EXISTS `idx_issue_comments_workspace_id` ON `issue_comments` (`workspace_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_plugin_loop_events_project_id` ON `plugin_loop_events` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_issue_dependencies_depends_on_id` ON `issue_dependencies` (`depends_on_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workspaces_skill_id` ON `workspaces` (`skill_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_skills_project_id` ON `agent_skills` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_scheduled_runs_skill_id` ON `scheduled_runs` (`skill_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_scheduled_runs_project_id` ON `scheduled_runs` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_projects_default_skill_id` ON `projects` (`default_skill_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_nodes_skill_id` ON `workflow_nodes` (`skill_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_edges_to_node_id` ON `workflow_edges` (`to_node_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_plugin_view_processes_project_id` ON `plugin_view_processes` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workspace_provisioning_project_id` ON `workspace_provisioning` (`project_id`);
