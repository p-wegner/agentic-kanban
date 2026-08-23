-- #815: extract the FIFTH column family out of `workspaces` (after `merge_backoff_*` in
-- #781 and `review_preflight_*` / `code_metrics_*` / `latest_symlink_*` in #798).
--
-- `merge_gate_*` (5 columns) -> `workspace_merge_gate`, keyed by `workspace_id`.
--
-- WHAT THESE COLUMNS ARE: real evidence that the pre-merge gate ran and passed for this
-- branch -- when it FINISHED (`ran_at`), the stage it reached, the path that produced it,
-- and the branch/base tips it ran against (0108, so the proof is checkable by CONTENT and
-- not merely by age). #182 added them precisely so a monitor merge trigger could stop
-- fabricating `ranAt: new Date()`. They are the board's audit trail for "was this actually
-- verified", which is exactly the kind of thing that wants its own table rather than five
-- more columns on the hottest row in the schema.
--
-- Coupling re-derived on the column names AND the camelCase Drizzle fields (#798's lesson:
-- #739's published counts were prose-inflated). The ticket estimated ~7 files; 4 non-test
-- files actually NAME them:
--   * `schema/workspaces.ts` (the declaration),
--   * `startup/exit-workflow.ts` (`armReadyForMerge` -- the sole writer),
--   * `startup/exit/fix-and-merge-exit.ts` (the clear, when a fix-and-merge run voids the proof),
--   * `startup/monitor-setup.ts` (the candidate SELECT).
-- Two more MENTION `mergeGate*` only in a comment (`services/pre-merge-gate.service.ts`,
-- `services/workspace-build-refresh.service.ts`) and one -- `startup/monitor-cycle.ts` --
-- reads the five fields off the PROJECTED ROW rather than off the table, so aliasing the new
-- columns back to `mergeGateRanAt` & co. in the monitor's select leaves it untouched. That
-- aliasing is what keeps this a 4-file change.
--
-- ABSENT ROW == "no trustworthy evidence", which is the same state five NULL columns held:
-- `resolveMergeGate` re-runs the gate when the evidence is missing, and the clear is now
-- spelled as a DELETE. So the reads LEFT JOIN from `workspaces` -- an inner join would make
-- every never-gated workspace invisible to the monitor's candidate walk, silently stopping
-- every first merge.
--
-- `workspace_id` is the PRIMARY KEY and declares its FK with ON DELETE CASCADE: a parent-id
-- column without a declared FK is invisible to the cascade gates (#948), and the PK's
-- automatic index satisfies the FK-leading-index ratchet (#740).
CREATE TABLE `workspace_merge_gate` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`ran_at` text,
	`stage` text,
	`source` text,
	`branch_sha` text,
	`base_sha` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Backfill BEFORE the drop, in the same migration. Sparse by nature: only a workspace whose
-- gate actually ran carries evidence, and the WHERE clause is what keeps the never-gated
-- majority row-free -- which is the state the reads reconstruct anyway.
INSERT INTO `workspace_merge_gate`
	(`workspace_id`, `ran_at`, `stage`, `source`, `branch_sha`, `base_sha`)
SELECT
	`id`,
	`merge_gate_ran_at`,
	`merge_gate_stage`,
	`merge_gate_source`,
	`merge_gate_branch_sha`,
	`merge_gate_base_sha`
FROM `workspaces`
WHERE `merge_gate_ran_at` IS NOT NULL
	OR `merge_gate_stage` IS NOT NULL
	OR `merge_gate_source` IS NOT NULL
	OR `merge_gate_branch_sha` IS NOT NULL
	OR `merge_gate_base_sha` IS NOT NULL;
--> statement-breakpoint
-- Dropped in the SAME migration: a facade would leave two sources of truth and a duplicated
-- write path, which is worse than either alternative (#781 DoD 3). None of these five columns
-- carries an index, so the drop is in-place and FK-clean (libsql ships SQLite 3.45.1).
ALTER TABLE `workspaces` DROP COLUMN `merge_gate_ran_at`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `merge_gate_stage`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `merge_gate_source`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `merge_gate_branch_sha`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `merge_gate_base_sha`;