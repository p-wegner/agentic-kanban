-- #945: the durable "a merge is in flight" marker.
--
-- `merge-job.service.ts` tracks a merge purely in memory and its header defends that as
-- correct ("a server restart legitimately forgets it — the merge died with the process too").
-- Observed live on #919: a ~15-minute gate, a `tsx watch` reload mid-gate, and afterwards
-- `GET /:id/merge-status` -> `{"job": null}` with the workspace still `ready_for_merge = 1`,
-- `status = 'idle'`, `merged_at` NULL. Nothing anywhere recorded that a merge had been
-- attempted, so the workspace read as armed-and-healthy to every consumer including the
-- monitor, and only moved when a human noticed master had not advanced.
--
-- This is the single-workspace counterpart of `merge_trains` (#906): ONE row, written when a
-- merge job starts and deleted the moment it reaches any terminal state — so a row found at
-- boot is by construction a merge whose runner died. `startup/merge-run-reconciler.ts` turns
-- it into a recorded terminal state (a `merge-attempt` note) and re-arms the retry, instead of
-- leaving the attempt unaccounted for.
CREATE TABLE `workspace_merge_run` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`started_at` text NOT NULL,
	`source` text,
	`pid` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
