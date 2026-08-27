-- #906: persist the release train that `merge-train.service.ts` / `merge-queue.service.ts`
-- previously ran as pure per-request scratch state — a `label = q<Date.now()>` string held
-- only in the closure of `runTrainStrategy`'s async generator, with its
-- `kanban/train/<label>` git ref deleted in a `finally` no matter the outcome. A `tsx watch`
-- restart mid-gate (or any process death) left no trace a train had ever existed, and no way
-- to tell whether its members were mid-flight or abandoned (the #893 shape, but for a whole
-- batch instead of one workspace).
--
-- The startup reconciler (`startup/merge-train-reconciler.ts`) is what makes an
-- `assembling`/`gating` row with no live job a NAMED outcome (resumed, or `abandoned` with a
-- reason in `reconciled_reason`) rather than a row nobody ever looks at again.
--
-- `member_workspace_ids`, `gate_evidence`, `bisect_result` are plain JSON-encoded `text`
-- columns — this repo's convention for JSON-ish data (`base-branch-health.repository.ts`,
-- `plugin-loop-events.repository.ts`), not a typed drizzle JSON mode.
CREATE TABLE `merge_trains` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`label` text NOT NULL,
	`member_workspace_ids` text NOT NULL,
	`state` text DEFAULT 'assembling' NOT NULL,
	`gate_evidence` text,
	`bisect_result` text,
	`reconciled_reason` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_merge_trains_project_id` ON `merge_trains` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_merge_trains_state` ON `merge_trains` (`state`);
