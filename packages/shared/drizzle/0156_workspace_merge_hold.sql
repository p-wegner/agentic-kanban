-- #1164: an operator-placed per-workspace HOLD on merging, so one known-red workspace can be
-- parked without disabling auto-merge for the whole project (the only lever before this).
--
-- One row per workspace, present only while held — same shape as `workspace_merge_backoff`
-- (0131): "no row" cleanly means "not held".
CREATE TABLE `workspace_merge_hold` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`reason` text,
	`held_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
