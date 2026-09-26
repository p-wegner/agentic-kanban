-- #1253 (#1246 follow-up): the moment a workspace became ready-for-merge, so the queue-pressure
-- signal's readySince survives a later unrelated update to the workspace row.
--
-- One row per workspace, present only while ready — same shape as `workspace_merge_hold`
-- (0156): "no row" cleanly means "not ready".
CREATE TABLE `workspace_ready_for_merge` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`ready_since` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
