-- #1030: one row per DISCARDED pre-merge-gate verdict, and #1011: the PASSING gate's message.
--
-- The #243 protocol throws a passing gate verdict away when a tip moved during the run. Until
-- now that discard survived only as a console.warn in a live server log (truncated on every
-- `pnpm dev`) and on the in-memory merge job; `workspace_merge_gate` holds evidence for a token
-- that WAS minted, so by construction it never holds a discard. #1017 had to reconstruct base
-- movement from `git log` committer dates to answer "should the discard be relaxed?".
--
-- `merge_gate_discards` is append-only instrumentation: the sha pair per tip, the file list of
-- the base move (`git diff --name-only <before> <after>`), and the impact selection the run was
-- made under. It changes nothing about what `movedDuringGate` decides. The workspace FK gets its
-- own leading index (#740) because this table holds many rows per workspace.
--
-- `workspace_merge_gate.message` records the PASSING gate's tier message ("pre-merge gate passed
-- (tier: file-scoped, ...)"), which was only ever logged — so "a level may only weaken
-- verification VISIBLY" held only for whoever watched the server log at that moment. NULL for
-- evidence written before this landed.
CREATE TABLE `merge_gate_discards` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`discarded_at` text NOT NULL,
	`source` text NOT NULL,
	`stage` text,
	`duration_ms` integer,
	`job_id` text,
	`attempt` integer,
	`moved` text NOT NULL,
	`branch_sha_before` text,
	`branch_sha_after` text,
	`base_sha_before` text,
	`base_sha_after` text,
	`base_move_files` text,
	`impact_selection` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_merge_gate_discards_workspace` ON `merge_gate_discards` (`workspace_id`);--> statement-breakpoint
ALTER TABLE `workspace_merge_gate` ADD `message` text;