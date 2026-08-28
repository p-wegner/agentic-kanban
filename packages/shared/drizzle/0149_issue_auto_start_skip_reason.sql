-- #919: the last `AutoStartSkipReason` PER ISSUE, so "why is #57 not running" is answerable
-- from the issue panel. Before this the reasons existed only as per-project tallies inside a
-- single monitor cycle's return value (`AutoStartSkipInfo.reasonCounts`), which said
-- `wip_cap: 7` without naming one of the seven tickets and was gone once the cycle ended.
--
-- `last_auto_start_skip_reason` is one of the `AutoStartSkipReason` tokens (`wip_cap`,
-- `machine_saturated`, `contention_gate`, ...); `last_auto_start_skip_at` is when the monitor
-- recorded it. Both nullable with no default: an issue the monitor has never declined has no
-- skip reason, and NULL says exactly that (same "absence is the neutral value" rule as 0145).
--
-- Cleared when the monitor DOES start the issue, so a stale "held for wip_cap" never sits on a
-- ticket that is running — the field answers "why is this not running", and it must not answer
-- it for a ticket that is.
ALTER TABLE `issues` ADD `last_auto_start_skip_reason` text;--> statement-breakpoint
ALTER TABLE `issues` ADD `last_auto_start_skip_at` text;
