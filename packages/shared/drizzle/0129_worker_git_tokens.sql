-- #775: git-transport token scopes, so the board does not FORGET a token it issued.
--
-- The scope (worker, project, incoming ref, expiry) lived only in an in-memory
-- `createExpiringDigestStore`. After a board restart the store was empty, so a worker
-- finishing its run pushed with a token the board no longer knew and got a 401 on every
-- retry — the work survived only as an orphan `kanban/<sessionId>` branch in the worker's
-- cache clone. That is what made #745's recovery promise partial.
--
-- Only the sha-256 DIGEST is stored, never the token (same rule as `workers.token_hash`).
-- No foreign key to `workers` on purpose: revocation deletes these rows explicitly, and an
-- FK would make the fire-and-forget insert behind the synchronous `issueToken` fail
-- silently whenever the worker row is written in the same turn.
CREATE TABLE IF NOT EXISTS `worker_git_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`project_id` text NOT NULL,
	`incoming_ref` text,
	`issued_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_worker_git_tokens_worker_id` ON `worker_git_tokens` (`worker_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_worker_git_tokens_expires_at_ms` ON `worker_git_tokens` (`expires_at_ms`);
