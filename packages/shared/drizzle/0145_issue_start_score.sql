-- #917: scored ticket selection replaces FIFO `ORDER BY issue_number` in the Todo pull
-- loop (`runTodoPull`, startup/monitor-auto-start.ts). Persisted so the score is
-- deterministic and explainable rather than recomputed silently: `last_start_score` is
-- the final number the pull loop sorted candidates by on its most recent evaluation,
-- `last_start_score_components_json` is the breakdown (priorityWeight, unblockCount,
-- ageFactor, predictedCost, bullseyeMultiplier) that produced it, and
-- `last_start_scored_at` is when. All three are nullable with no default: an issue that
-- has never been evaluated as a Todo/Backlog candidate has never been scored, and NULL
-- says exactly that (same "absence is the neutral value" rule as 0141/0142/0143).
ALTER TABLE `issues` ADD COLUMN `last_start_score` real;--> statement-breakpoint
ALTER TABLE `issues` ADD COLUMN `last_start_score_components_json` text;--> statement-breakpoint
ALTER TABLE `issues` ADD COLUMN `last_start_scored_at` text;
