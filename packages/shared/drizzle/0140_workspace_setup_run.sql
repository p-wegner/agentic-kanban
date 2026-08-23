-- #815: extract the SEVENTH column family out of `workspaces` (after `merge_backoff_*` in
-- #781, `review_preflight_*` / `code_metrics_*` / `latest_symlink_*` in #798, and
-- `merge_gate_*` in 0138 / `conflict_cache_*` in 0139).
--
-- `latest_setup_*` (8 columns) -> `workspace_setup_run`, keyed by `workspace_id`.
--
-- WHAT THESE COLUMNS ARE: a RUN RECORD whose history is the point. A workspace that comes up
-- `blocked` is diagnosed from exactly this -- command, state, exit code, duration, and the
-- two output tails. `startup/born-blocked-reconciler.ts` restamps it on a retry precisely so
-- the operator reads a dated verdict rather than one from five days ago, and
-- `services/workspace-timeline.service.ts` renders it as two timeline events. So this is the
-- `latest_symlink_*` case again -- written at creation, in the same transaction as the
-- workspace row -- and 0136 is the pattern this migration follows almost verbatim.
--
-- Coupling re-derived on the column names AND the camelCase Drizzle fields. The ticket
-- estimated ~10 files; 6 actually name them against the TABLE:
--   * `schema/workspaces.ts` (the declaration),
--   * `services/workspace-create.service.ts` (the creation write),
--   * `repositories/workspace-crud.repository.ts` (`updateLatestSetupRunFields`),
--   * `startup/born-blocked-reconciler.ts` (a 2-column read and a 4-column restamp),
--   * `repositories/issue.repository.ts` + `repositories/workspace-reads.repository.ts`
--     (the two reads, all eight each).
-- Four more read the eight fields off a PROJECTED ROW and are untouched, because both reads
-- alias the new columns back to `latestSetup*`: `lib/workspace-details-projection.ts`,
-- `services/issue.service.ts`, `services/workspace-launch-failures.service.ts`,
-- `services/workspace-timeline.service.ts`. Two more merely carry a
-- `latestSetup: WorkspaceSetupRun` DTO/param (`services/workspace-internals.ts`,
-- `shared/src/types/api/workspace.ts`) and one holds a local variable of that name with no
-- column reference at all (`services/workspace-provision.service.ts`). The five client
-- components that render `latestSetup` consume the DTO, which does not change.
--
-- ABSENT ROW == no setup run recorded, exactly as a NULL `latest_setup_state` meant: the
-- projection maps that to `latestSetup: null`. The reads therefore LEFT JOIN from
-- `workspaces`; an inner join would make every workspace without a record unreadable.
--
-- `workspace_id` is the PRIMARY KEY and declares its FK with ON DELETE CASCADE: a parent-id
-- column without a declared FK is invisible to the cascade gates (#948), and the PK's
-- automatic index satisfies the FK-leading-index ratchet (#740).
CREATE TABLE `workspace_setup_run` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`command` text,
	`state` text,
	`started_at` text,
	`ended_at` text,
	`exit_code` integer,
	`duration_ms` integer,
	`stdout_tail` text,
	`stderr_tail` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Backfill BEFORE the drop, in the same migration. Like `latest_symlink_*`, nearly every
-- existing workspace carries a record (the create path always wrote one, including the
-- `skipped` run for a project with no setup script), so this is not the sparse case the
-- earlier families were -- the WHERE clause only skips rows that hold nothing at all, and
-- the reads reconstruct `latestSetup: null` for those anyway.
INSERT INTO `workspace_setup_run`
	(`workspace_id`, `command`, `state`, `started_at`, `ended_at`, `exit_code`, `duration_ms`,
	 `stdout_tail`, `stderr_tail`)
SELECT
	`id`,
	`latest_setup_command`,
	`latest_setup_state`,
	`latest_setup_started_at`,
	`latest_setup_ended_at`,
	`latest_setup_exit_code`,
	`latest_setup_duration_ms`,
	`latest_setup_stdout_tail`,
	`latest_setup_stderr_tail`
FROM `workspaces`
WHERE `latest_setup_command` IS NOT NULL
	OR `latest_setup_state` IS NOT NULL
	OR `latest_setup_started_at` IS NOT NULL
	OR `latest_setup_ended_at` IS NOT NULL
	OR `latest_setup_exit_code` IS NOT NULL
	OR `latest_setup_duration_ms` IS NOT NULL
	OR `latest_setup_stdout_tail` IS NOT NULL
	OR `latest_setup_stderr_tail` IS NOT NULL;
--> statement-breakpoint
-- Dropped in the SAME migration: a facade would leave two sources of truth and a duplicated
-- write path, which is worse than either alternative (#781 DoD 3). None of these eight
-- columns carries an index, so the drop is in-place and FK-clean (libsql ships SQLite 3.45.1).
ALTER TABLE `workspaces` DROP COLUMN `latest_setup_command`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `latest_setup_state`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `latest_setup_started_at`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `latest_setup_ended_at`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `latest_setup_exit_code`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `latest_setup_duration_ms`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `latest_setup_stdout_tail`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `latest_setup_stderr_tail`;