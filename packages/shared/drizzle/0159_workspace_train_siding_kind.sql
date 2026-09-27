-- A siding held a branch whose tip had not moved even after the base stopped conflicting with
-- it (#1253/#1261, 2026-09-27: released by hand with update-base). The train now re-probes a
-- CONFLICT siding against the current base, but a REVIEW siding (#1194) must stay held until
-- the tip moves: a clean merge says nothing about a review finding. This column tells them
-- apart. NULL = a row written before the column existed; it keeps the old tip-only rule.
ALTER TABLE `workspace_train_siding` ADD `kind` text;
