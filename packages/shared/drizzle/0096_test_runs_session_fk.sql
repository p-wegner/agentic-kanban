-- #948: test_runs.session_id had no FK — outside the FK graph, the cascade walk, and
-- the completeness gate. Add FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE
-- cascade via the SQLite table-rebuild dance (mirrors 0010_session_messages_cascade).
-- Orphaned rows (session deleted before this FK existed) are purged first — the rebuild
-- would otherwise carry rows that immediately violate the new FK.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
DELETE FROM `test_runs` WHERE `session_id` NOT IN (SELECT `id` FROM `sessions`);--> statement-breakpoint
CREATE TABLE `test_runs_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`commit_sha` text,
	`test_name` text NOT NULL,
	`file` text,
	`suite` text,
	`passed` integer NOT NULL,
	`duration_ms` integer,
	`error_message` text,
	`runner` text NOT NULL DEFAULT 'vitest',
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `test_runs_new` SELECT * FROM `test_runs`;--> statement-breakpoint
DROP TABLE `test_runs`;--> statement-breakpoint
ALTER TABLE `test_runs_new` RENAME TO `test_runs`;--> statement-breakpoint
CREATE INDEX `idx_test_runs_session_id` ON `test_runs` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_test_runs_test_name` ON `test_runs` (`test_name`);--> statement-breakpoint
CREATE INDEX `idx_test_runs_file` ON `test_runs` (`file`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
