-- #1110: base-health sweep verdicts carried no evidence of a retry or of machine load, so a
-- red/timeout caused by box contention was indistinguishable from a genuinely broken base.
ALTER TABLE `base_branch_health` ADD `flaky` integer;
--> statement-breakpoint
ALTER TABLE `base_branch_health` ADD `contention` text;
