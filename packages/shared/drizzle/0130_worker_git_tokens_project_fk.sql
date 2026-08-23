-- #775 follow-up, caught by the wave gate: `worker_git_tokens.project_id` shipped in 0129
-- with no `.references()`, which `issue-cascade-completeness.repo.test.ts` fails on.
--
-- That rule exists because of #948: a parent-id column WITHOUT a declared FK is invisible to
-- the whole cascade gate, so `test_runs.session_id` orphaned rows forever, silently. The same
-- would have happened here — and it matters more than for a log table, because a git token is
-- a CAPABILITY: a row that outlives its project is an authorisation outliving its subject.
--
-- 0129 deliberately omits an FK to `workers`, and that reasoning stands (revocation deletes
-- these rows explicitly, and an FK would make the fire-and-forget insert behind the
-- synchronous `issueToken` fail silently when the worker row lands in the same turn). It does
-- NOT transfer to `projects`: a token is only ever issued for a project the dispatch already
-- resolved, so the parent row is committed before the insert.
--
-- SQLite cannot ADD CONSTRAINT, so the table is rebuilt — same shape as 0120 (the FK that
-- plugin_view_processes gained for the same reason). 0129 is already applied to live boards,
-- so amending it in place was not an option. Rows whose project has since vanished are left
-- behind deliberately: that is precisely the orphaned authorisation this migration stops.
CREATE TABLE `worker_git_tokens_new` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`project_id` text NOT NULL,
	`incoming_ref` text,
	`issued_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `worker_git_tokens_new` SELECT * FROM `worker_git_tokens` WHERE `project_id` IN (SELECT `id` FROM `projects`);
--> statement-breakpoint
DROP TABLE `worker_git_tokens`;
--> statement-breakpoint
ALTER TABLE `worker_git_tokens_new` RENAME TO `worker_git_tokens`;
--> statement-breakpoint
CREATE INDEX `idx_worker_git_tokens_worker_id` ON `worker_git_tokens` (`worker_id`);
--> statement-breakpoint
CREATE INDEX `idx_worker_git_tokens_expires_at_ms` ON `worker_git_tokens` (`expires_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_worker_git_tokens_project_id` ON `worker_git_tokens` (`project_id`);
