-- #798: extract the FOURTH column family out of `workspaces` (after `merge_backoff_*` in
-- #781, `review_preflight_*` in 0134 and `code_metrics_*` in 0135).
--
-- `latest_symlink_*` (8 columns) -> `workspace_symlink_run`, keyed by `workspace_id`.
--
-- THIS FAMILY CARRIED #798's ONE OPEN QUESTION: extract, or RETIRE? Dependency Symlinks is
-- off by default (the board moved to install-per-worktree), so eight columns for it look like
-- a legacy feature paying rent on every row of the hottest table.
--
-- Answered: EXTRACT. The feature is live, not legacy, and the evidence is in the code rather
-- than in the default:
--   * `projects.symlink_enabled` / `symlink_dirs` are a per-project setting with real UI
--     (`packages/client/src/components/settings/ProjectSettings.tsx`),
--   * `services/workspace-provision.service.ts` calls `bootstrapSymlinks` whenever it is on,
--   * `packages/client/src/components/WorkspaceDiagnosticsPanel.tsx` renders exactly this run
--     record, and distinguishes `disabled` from `pending` using its `state`.
-- "Off by default" is a statement about how projects are configured — the same class of
-- evidence as #739's twelve always-NULL columns, which it likewise refused to read as dead
-- code. Retiring these would delete a working opt-in.
--
-- Coupling re-derived: #739 said 9 non-test files; 5 actually name the columns — the writer
-- (`services/workspace-create.service.ts`), the two reads (`repositories/issue.repository.ts`,
-- `repositories/workspace-reads.repository.ts`), `lib/workspace-details-projection.ts` and
-- `services/issue.service.ts`, the last two reading them off the projected ROW rather than the
-- table. Both reads alias the new columns back to the old `latestSymlink*` field names, so the
-- projection, the DTO and the client are untouched by the move.
--
-- One row per workspace, written at creation in the same transaction as the workspace row —
-- including the `state = 'disabled'` run a project with the feature off produces, because
-- that is what the columns held and the panel distinguishes it from "pending". The saving is
-- therefore table width and hot-row size, not row count: eight text/JSON columns that no
-- board read path wants leave the row every board query touches.
--
-- `workspace_id` is the PRIMARY KEY and declares its FK with ON DELETE CASCADE: a parent-id
-- column without a declared FK is invisible to the cascade gates (#948), and the PK's
-- automatic index satisfies the FK-leading-index ratchet (#740).
CREATE TABLE `workspace_symlink_run` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`state` text,
	`started_at` text,
	`ended_at` text,
	`dirs` text,
	`linked` text,
	`skipped` text,
	`failed` text,
	`error` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Backfill BEFORE the drop, in the same migration. Every existing workspace carries a run
-- record (the create path always wrote one), so this is not the sparse case the earlier three
-- families were: the WHERE clause only skips rows that somehow have nothing at all, and the
-- reads reconstruct `null` for those anyway.
INSERT INTO `workspace_symlink_run`
	(`workspace_id`, `state`, `started_at`, `ended_at`, `dirs`, `linked`, `skipped`, `failed`, `error`)
SELECT
	`id`,
	`latest_symlink_state`,
	`latest_symlink_started_at`,
	`latest_symlink_ended_at`,
	`latest_symlink_dirs`,
	`latest_symlink_linked`,
	`latest_symlink_skipped`,
	`latest_symlink_failed`,
	`latest_symlink_error`
FROM `workspaces`
WHERE `latest_symlink_state` IS NOT NULL
	OR `latest_symlink_started_at` IS NOT NULL
	OR `latest_symlink_ended_at` IS NOT NULL
	OR `latest_symlink_dirs` IS NOT NULL
	OR `latest_symlink_linked` IS NOT NULL
	OR `latest_symlink_skipped` IS NOT NULL
	OR `latest_symlink_failed` IS NOT NULL
	OR `latest_symlink_error` IS NOT NULL;
--> statement-breakpoint
-- Dropped in the SAME migration: a facade would leave two sources of truth and a duplicated
-- write path, which is worse than either alternative (#781 DoD 3). #739 measured DROP COLUMN
-- as in-place and FK-clean here (libsql ships SQLite 3.45.1); none of these eight columns
-- carries an index (only `showdown_id` and `parent_workspace_id` do, and neither is touched).
ALTER TABLE `workspaces` DROP COLUMN `latest_symlink_state`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `latest_symlink_started_at`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `latest_symlink_ended_at`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `latest_symlink_dirs`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `latest_symlink_linked`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `latest_symlink_skipped`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `latest_symlink_failed`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `latest_symlink_error`;
