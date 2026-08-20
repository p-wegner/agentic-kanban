-- Content-key the persisted pre-merge gate evidence (throughput/correctness).
--
-- 0105 added merge_gate_ran_at/stage/source so the monitor could build honest
-- `MergeGateEvidence` instead of fabricating `ranAt: new Date()` (#182). But time alone
-- cannot answer the question a merge actually asks — "was THIS branch, against THIS base,
-- verified?" — so a commit pushed after the gate could merge inside the freshness window on
-- proof describing different code, while a merge that merely waited in a queue was forced to
-- re-run a 30-45 minute gate for no reason.
--
-- These two columns record the tips the gate ran against, so evidence can be validated by
-- content: age becomes irrelevant when both still match, and the proof is void the moment
-- either has moved. Nullable — evidence written before this migration (and callers that
-- cannot resolve a ref) keeps validating on age alone.
ALTER TABLE `workspaces` ADD `merge_gate_branch_sha` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `merge_gate_base_sha` text;
