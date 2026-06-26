# Verification log — Phase 4 (repeatable, multi-strategy)

Append-only ledger. Each round records the strategy lens used, new findings (with a
dedup key), and dispositions. Re-runs read this to (a) pick lenses not yet used and
(b) report only findings NOT already keyed here. Strategy catalog + loop:
`<skill>/references/verification-strategies.md`.

Loop-until-dry: stop when ~2 consecutive fresh strategies add no new important finding.

---

## Round 1 — S1 file-coverage  ·  sha 2cea8d3e→29e016dc
Tool: `tools/coverage.py`. **Found:** 104 important files unmapped (18% mapped) →
drove `preferences-config` + `project-registration` to docs; rest deferred-with-reason.
Gate now PASS @120 and @100. Findings → `_coverage.md`.
Keys: `missing:preferences-config` (fixed), `missing:project-registration` (fixed),
`missing:cli` `missing:client-app-shell` `missing:server-bootstrap` (deferred-with-module),
`drift:issue-dependency.service` (fixed).

## Round 2 — S2 per-module refutation  ·  sha 2cea8d3e
12 reviewers. 6 sound / 6 needs-fix. **Found & fixed:** fabricated FK-cascade claim
(persistence-schema), mis-attributed merge gate (review-merge → pre-merge-gate), false
"dead prompt" (butler), mis-located createWorkspace orchestrator (workspaces),
deriveStatusName unwired (workflow-engine), status-view.ts omission (issues-board).
Findings → `_review.md`.
Keys: `accuracy:*` (all fixed).

## Round 3 — S3 requirements mining  ·  sha 29e016dc
4 source agents (PRD / ADRs / tests / constraints+errors). **Found & fixed (blind spots):**
dep-pinning ADR-009, typed-error contract+AiOperationError, crash-resilience,
dependency-auto-chain, dependency-wave, zombie-fix reconciler, #629/#583/ancestor
reconciler guards, createIssue node-alignment, reset --soft, diff_comments table,
DB-mutation rule, agent-role vocab. **Deferred-with-module:** diff-review UI, analytics
views, settings/shell, flaky-radar, voice, scheduled-runs, quality-score, desktop, AI ticket utils.
Findings → `_requirements-coverage.md`.
Keys: `missing:dep-pinning` `missing:typed-errors` `missing:crash-resilience`
`missing:dependency-auto-chain` `missing:dependency-wave` `missing:zombie-reconciler`
`missing:zero-commit-ready-guard` `missing:reconcile-noop-583` `missing:ancestor-reconciler-guards`
`missing:createissue-node-align` `missing:reset-soft` `missing:diff-comments-table`
`missing:db-mutation-rule` `missing:agent-role-vocab` (all fixed);
`defer:diff-review-ui` `defer:analytics-views` `defer:client-shell` `defer:flaky-radar`
`defer:voice-inbox` `defer:scheduled-runs` `defer:quality-score` `defer:desktop`
`defer:ai-ticket-utils` (deferred-with-module).

## Round 4 — S4 scenario-tracing + S5 failure-mode + S6 data-lifecycle + S7 contradiction-hunt  ·  sha 29e016dc
Fresh lenses (behavioral + consistency families), deduped against Rounds 1–3. **NOT dry — 5 new findings, all fix-now, all fixed:**
- `gap:rate-limit-rotation-resume` (S4) — credential-ring rotation-and-resume engine (`exit-workflow.ts handleUsageLimitExit` + `rate-limit-exit-decision.ts`; builder-only relaunch; `blocked` has reconcilers but none RESUME the ticket) → folded into **agent-providers.md** (workflow §5 + invariants + blocked-gap).
- `lifecycle:session_messages-pruning` (S6) — 6h pruner: 3-day merged-retention + 2000-row cap (`session-message-pruner.service.ts`); also a 2nd cause of transcript-search decay → **agent-sessions.md**.
- `failmode:db-backup-restore` + `contradiction:db-unrecoverable` (S5/S6) — VACUUM-INTO backup/verify-or-refuse/rotate(KEEP_LAST=5, 5GB cap)/restore subsystem undocumented AND persistence-schema.md falsely said "a single wipe is unrecoverable" → corrected + workflow §5 in **persistence-schema.md**.
- `contradiction:active-capacity-awaiting-plan-approval` (S7) — workspaces.md "three aligned places" SSOT claim wrong: monitor uses a separate `AUTO_START_WIP_STATUSES` (3, excludes awaiting-plan-approval) so plan-awaiting work counts as board capacity but not monitor WIP → **workspaces.md** softened + 4th-list named.
- `drift:providersessionid-doc-lag` (S7 corroboration) — agent-providers.md + workspaces.md stated `claudeSessionId` as the real column; it's `providerSessionId` (schema:14) → both fixed.
Credibility: scenarios 1,2,4,5,6,7 traced clean; doc set otherwise internally consistent (dual terminal-status sets, two dep-readiness predicates, the three "mode" vocabularies all described consistently).

Strategies used so far: **S1, S2, S3, S4, S5, S6, S7**. Not yet run: **S8** (run-the-system/empirical), **S9** (drift since analyzed_sha), **S10** (invariant-density), and persona overlays. Round 4 was NOT dry → not converged; next run should use S8–S10 + a persona before declaring the structural lenses dry.
