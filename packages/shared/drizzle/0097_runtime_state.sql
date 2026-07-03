-- #975: split unbounded/ephemeral RUNTIME STATE out of the `preferences` KV table so
-- `preferences` becomes the closed, registry-backed CONFIG set. The new `runtime_state`
-- table holds per-toolUseId agent-question markers (unbounded), butler session ids +
-- history, agent-profile launch-failure payloads, and rate-limit timestamps. Existing
-- rows of those namespaces are moved over, then removed from `preferences`.
CREATE TABLE `runtime_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	`expires_at` text
);--> statement-breakpoint
CREATE INDEX `runtime_state_expires_at_idx` ON `runtime_state` (`expires_at`);--> statement-breakpoint
INSERT OR IGNORE INTO `runtime_state` (`key`, `value`, `updated_at`, `expires_at`)
SELECT `key`, `value`, `updated_at`, NULL FROM `preferences`
WHERE `key` LIKE 'agent_question_answered_%'
	OR `key` LIKE 'agent_question_recommendation_%'
	OR `key` LIKE 'butler_session_%'
	OR `key` LIKE 'agent_profile_launch_failure.%'
	OR `key` = 'backlog_empty_last_run';--> statement-breakpoint
DELETE FROM `preferences`
WHERE `key` LIKE 'agent_question_answered_%'
	OR `key` LIKE 'agent_question_recommendation_%'
	OR `key` LIKE 'butler_session_%'
	OR `key` LIKE 'agent_profile_launch_failure.%'
	OR `key` = 'backlog_empty_last_run';
