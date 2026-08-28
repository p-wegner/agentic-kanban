-- #906: `workspace_merge_gate` stored verdicts (ranAt/stage/source/tips) but never how long
-- the run took, so gate cost was unmeasured even though the gate is a 20-45 minute cost per
-- the #906 proposal's own numbers. `duration_ms` is wall-clock time bracketed around the gate
-- run in `runGateWithEvidence` (`services/merge-gate-evidence.ts`), the single choke point
-- both the review-exit and pre-lock-merge callers already go through. Nullable: a reused
-- persisted verdict (#893) paid no new run and has no fresh duration to report.
ALTER TABLE `workspace_merge_gate` ADD `duration_ms` integer;
