-- #1192: sidings — a merge-train member dropped for a conflict gets one row here instead of
-- silently falling back into the same conflict next window.
--
-- One row per workspace, written lazily on the first train drop and cleared once the branch
-- tip moves (a rebase happened) or the member lands. `sided_branch_sha` is what a re-admission
-- check keys on — the same "is the recorded sha still the branch's tip?" shape
-- `monitor-gate-recall` already uses for the sequential gate-review path, applied here to the
-- train's window instead. `capped_at` is set once, edge-triggered, when `sidings` reaches the
-- cap — from then on the member is left withheld (no further `/turn`) until a human or a real
-- rebase moves the branch, mirroring `workspace_merge_backoff`'s ceiling.
--
-- `workspace_id` is the PRIMARY KEY and declares its FK to `workspaces` with ON DELETE CASCADE,
-- per the root CLAUDE.md's cascade-gate convention (#948/#740): both are required for the row
-- to be visible to the cascade gates and to satisfy the FK-leading-index ratchet.
CREATE TABLE `workspace_train_siding` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`sidings` integer DEFAULT 0 NOT NULL,
	`sided_branch_sha` text,
	`conflict_train_tip_sha` text,
	`last_sided_at` text,
	`capped_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
