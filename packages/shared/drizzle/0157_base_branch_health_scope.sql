-- #1231: the base sweep's verdict row did not say what MODE the verify script ran in — full,
-- package-scoped, file-scoped, impact-selected, guards-only — so a scoped green read exactly
-- like a full-suite green and could promote. Parsed off the runner's own
-- `[gate:step] name=tests ... scope=<mode>` self-report; NULL when it reported nothing.
ALTER TABLE `base_branch_health` ADD `scope` text;
