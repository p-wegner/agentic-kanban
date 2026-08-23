-- #774 (remaining #755 item 1): a per-worker event timeline, so a #699/#706-class fleet
-- failure is not reconstructed from server scrollback that a restart has already discarded.
--
-- RETENTION IS PART OF THE DESIGN, not a follow-up. The repository caps rows PER WORKER
-- (WORKER_EVENT_RETENTION_LIMIT = 300) and prunes the oldest past that cap, so this table's
-- ceiling is `registered workers x 300` and does not grow with fleet traffic. An unbounded
-- event log is #738 again (99,140 issue comments, 127 MB of a 186 MB DB).
--
-- `worker_id` has NO foreign key, matching `worker_git_tokens.worker_id` (0129) and for the
-- same reason: revocation deletes these rows explicitly, and event writes are fire-and-forget
-- (a diagnostic must never break a fleet operation), so an FK rejection would surface as
-- SILENCE rather than an error — the `registered` event writes in the same turn as the worker
-- row. `worker_id` is not in the parent-id name set the cascade gate polices.
--
-- `session_id` DOES carry a cascading FK, declared here rather than bolted on afterwards --
-- 0129 shipped `project_id` FK-less and 0130 had to rebuild the whole table to add it.
CREATE TABLE `worker_events` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`type` text NOT NULL,
	`session_id` text,
	`summary` text NOT NULL,
	`payload_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_worker_events_worker_created` ON `worker_events` (`worker_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_worker_events_session_id` ON `worker_events` (`session_id`);
