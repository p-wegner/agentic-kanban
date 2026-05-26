CREATE INDEX `idx_workspaces_status` ON `workspaces` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_workspaces_created_at` ON `workspaces` (`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_sessions_status` ON `sessions` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_sessions_started_at` ON `sessions` (`started_at`);
--> statement-breakpoint
CREATE INDEX `idx_session_messages_session_id` ON `session_messages` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_session_messages_created_at` ON `session_messages` (`created_at`);
