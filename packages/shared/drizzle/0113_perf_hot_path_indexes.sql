-- Perf review 2026-08-11: hot-path indexes that were missing entirely.
-- issue_tags is joined on every board load (board-column.repository) and was a full scan;
-- issue_artifacts rows are large (base64 data URLs) so its scans read real pages;
-- project_statuses is inner-joined on every board load and the 30s auto-merge tick;
-- session_messages queries ORDER BY id DESC but only (session_id, created_at) existed,
-- forcing a temp B-tree sort of each session's matched set.
CREATE INDEX IF NOT EXISTS `idx_issue_tags_issue_id` ON `issue_tags` (`issue_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_issue_tags_tag_id` ON `issue_tags` (`tag_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_issue_artifacts_issue_id` ON `issue_artifacts` (`issue_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_issue_artifacts_workspace_id` ON `issue_artifacts` (`workspace_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_project_statuses_project_id` ON `project_statuses` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_session_messages_session_id_id` ON `session_messages` (`session_id`,`id`);
