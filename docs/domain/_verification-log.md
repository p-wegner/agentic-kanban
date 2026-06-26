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

## Round 5 — S11 git-history / commit-prefix requirement mining  ·  sha 29e016dc
Mined `feat`/recurring-`fix` scope clusters + multi-commit `#N` tickets; deduped against Rounds 1–4. **NOT dry — 2 new findings:**
- `missing:codemod-factory` (HIGH) — AI repo-wide structural codemod capability (`codemod.service.ts` 412 LOC + `routes/codemods.ts` 5 endpoints + `CodemodPanel.tsx`), with a VERIFIED security invariant (apply confines writes to repoPath via `isInside`, `codemod.service.ts:358`/guard `:331-337`; a `fix(codemods)` commit closed a path-traversal hole). Missed by S1 file-coverage because it's a low-blast-radius LEAF feature, not a hub — exactly S11's unique catch. → documented as new module **codemods.md** (15th).
- `missing:workspace-artifacts` (MEDIUM) — evidence artifacts (`.webm` visual proof) via `attach_artifact` MCP tool + Artifacts tab; `issue_artifacts` table was only in cascade lists. → folded into **workspaces.md** + **mcp-server.md** tool catalog.
Credibility: the big clusters (monitor×32, butler×16, workspace/teardown, git fixes×8, strategy×7, board) are all already covered; correctly filtered chore/docs/refactor/test noise + known-deferred (drive-obstacles, analytics, stack-profile→project-registration, codex-ring→rate-limit-rotation).
S11 insight: git-history mining catches **built-but-undocumented leaf features** (low fan-in, so blast-radius coverage under-weights them) and **recurring-incident invariants** — orthogonal to PRD (S3) and current-code (S1/S2).

## Round 6 — S8 run-the-system + S9 drift + S10 invariant-density  ·  server live, HEAD 1893733d
Ran the three remaining structural/empirical lenses against the live server + current code; deduped against Rounds 1–5. **3 new findings, all fix-now, all on issues-board.md, all fixed:**
- `missing:milestones` (S8, MEDIUM) — milestones capability (table + `milestoneId` FK on every issue + 5-route REST `/api/projects/:id/milestones`) had no owner doc → folded into **issues-board.md** (Milestone term + entry-points row; sibling to tags). 7 other capabilities verified clean against runtime (7-status seed, board read-model+ETag, `?slim=1` ~60%, dead `default_model` key, provider-divergence, quota-usage 503-degrade, MCP 14 categories).
- `stale-anchor:issue.service.ts` (S9, HIGH) — the dependency-sub-service extraction shrank issue.service.ts 1352→943 lines; my Round-3 fold-in re-anchored only the dependency citations, leaving ~14 non-dependency anchors STALE (one cited `:1162`, past EOF) → all re-anchored to verified current lines (contraction 582/621/629/639, title 315, nextIssueNumber 328, guards 451/538, archiveDoneIssues 888, sync 465/557, …). Also fixed the symmetric-edge anchor (moved to `issue-dependency.service.ts:24`).
- `missing-invariant:contraction-absorb-status` (S10, minor) — contraction requires a Cancelled/Done status to exist (400 if neither) + Cancelled-preferred absorb order → added to the contraction invariant.

S10 verdict: rule-density healthy across all logic-dense modules (doc invariant-rows ≈ code guard signals once threshold-noise discounted) — the structural/behavioral/historical/empirical/drift/density frontier is **effectively exhausted**.

**Convergence status:** S1–S11 all now run at least once. Round 6's only "new capability" was small (milestones); the rest were drift + a minor invariant. The undocumented-module rate has gone to ~0. **Near-converged** — remaining work is cadence re-runs of S8/S9 (drift moves with the code) + optional persona overlays (new-hire / SRE / security / the-agent-itself), which change what counts as a gap rather than finding new code. Declare structural convergence after one more dry round.
