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

**Convergence status (after R6):** S1–S11 all run; structural/behavioral/historical/empirical/drift/density frontier exhausted. Persona overlays still untried.

## Round 7 — PERSONA overlays (new-hire / SRE-on-call / security-auditor) + S9 re-check  ·  HEAD f2e9e78b
S9 re-check: no code commits since R6 → trivially dry. Persona pass was **NOT dry — 9 new findings** (personas change what counts as a gap → catch orientation/operational/security gaps capability-docs omit). All fixed:
- New-hire: `onboarding:no-operational-pointer` (README had no build/run/test pointer-out → added "Beyond these docs"), `onboarding:glossary-stale-vs-15-modules` (glossary said "12 modules/2cea8d3e", missing codemods/stack/milestones terms → refreshed to 15 + 16 terms).
- SRE: `runbook:boot-failure-triage` (HIGH — prevention guards documented but no symptom→recover table → added Operations incident→recovery table in README), `ops:git-index-lock-recovery` (stale `.git/index.lock` masquerades as DB lock → git-integration Risks), `ops:auto-merge-engine-selection` (no `merge_strategy` default/truth-table → review-merge: values direct/monitor/merge_queue, effective default merge_queue), `ops:looping-agent-no-live-signal` (chatty loop never trips the zero-output watchdog; no live operator signal → agent-sessions Risks).
- Security: **`security:cors-wildcard-rest`** (REAL ISSUE, not just a doc gap — `server-start.ts:65` `cors()` emits `Access-Control-Allow-Origin: *` over the unauthenticated REST surface; confused-deputy reachable from any browser tab → documented in README + flagged as a recommended CODE follow-up: tighten cors() to a localhost-origin allowlist), `security:webhook-egress-loopback` (the enforced loopback-only SSRF guard `outbound-webhook.ts:44-59` was undocumented → mcp-server invariant), `security:rest-bind-host-configurable` (KANBAN_HOST can rebind off loopback; acceptable-for-local, documented).

Credibility: each persona also confirmed large swaths are well-served (new-hire: entry-points/context-map/per-module reading guides; SRE: monitor decision-tree, stranded-review/merge-pileup/hung-vs-failed all supported; security: codemod confinement, MCP no-auth, git single-spawn, secret sanitization all documented).

**Convergence status (after R7):** structural lenses converged; the **persona dimension is a fresh productive frontier** (Round 7 not dry). Open code follow-up surfaced: **CORS wildcard** (`server-start.ts:65`) — a real local-app security weakness worth a ticket.
> Resolved after R7: the CORS wildcard was FIXED in code (commit 60debf73, `cors({origin: corsOrigin})` + `lib/cors-origin.ts` + test) — the harness's security-persona finding driven to a real fix.

## Round 8 — persona (the-AI-agent-itself) + S9 drift  ·  HEAD 60debf73
S9: one code commit since R7 (the CORS fix). It introduced **self-inflicted doc drift** — my edit shifted `server-start.ts` line numbers, so 3 anchors went stale → fixed (`README:209` 66→69, `README:214` 125→129, `agent-sessions:82` 222→226). (Good demonstration: S9 catches drift even from the harness's own commits.)
Persona (the-AI-agent-itself) — **near-dry, 1 new finding, fixed:**
- `agent-contract:cross-worktree-write-confinement` — the `prevent-cross-worktree-writes.js` + `require-read-before-write.js` PreToolUse HARD GATES (the runtime enforcement of workspaces.md's "blast radius is contained" promise) were documented only in CLAUDE.md, so a Builder treats a block as a bug and tries to route around it → added an "agent operating rule" invariant to **workspaces.md** mirroring the DB-safety-gate precedent (persistence-schema). Credibility: the agent contract is otherwise covered exceptionally well (hard constraints, create→launch, exit signals, gates, recovery all present).

**Convergence status (after R8):** Persona productivity has dropped sharply (R7 = 9 findings across 3 personas → R8 = 1 finding). All families (structural/behavioral/historical/empirical/drift/density/persona) have been sampled; the 4 personas (new-hire/SRE/security/the-agent) are exhausted. **Effectively converged** — remaining work is purely CADENCE: re-run S9 (drift) + S8 (run-the-system) whenever code lands, since those track a moving target; the discovery lenses have gone dry. A future "verify again" with no intervening code change should be expected to be DRY (the correct terminal state), unless a new lens is invented.

## Round 9 — S12 (NEW lens) quantitative constant-claims audit + S9 drift  ·  HEAD 676af1a2
S9: no code commit since R8 (only the R8 doc commit) → drift trivially dry, as predicted.
Invented a fresh lens to avoid a vacuous "dry" re-run: **S12 — quantitative constant-claims audit.**
Distinct from S10 (counts guard *density*) and S8 (probes *behavior*): S12 extracts every concrete
magic constant in the docs (caps, timeouts, intervals, ports, retry counts, thresholds, row/file/enum
counts, LOC, percentages) and verifies each against the code's source-of-truth `file:line`. Fanned out
3 agents over the 15 module docs. **~87 constants checked → NOT dry, 2 STALE (both mcp-server.md), both fixed:**
- `stale-count:mcp-tool-total` — "~95" appeared ×3: line 25 ("~95 tools", wrongly anchored at
  `mcp-tool-definitions.ts:23` = the category array, not the tool list), line 136 ("~95 tools"), and
  line 98 ("~95 tool names" on the `TOOL_REGISTRARS` row — missed in the first fix pass because a
  `"95 tools"` grep doesn't match `"95 tool names"`; caught on ledger re-verify). Real: **90** tool defs
  (`mcp-tool-definitions.ts:40` onward), **91** registrars (`index.ts:104` map). → 25/136 → "90 tools"
  with anchors split (defs `:40`, `McpToolCategory` union `:1-15`); line 98 → "91 tool names → registrars
  (vs 90 published defs)".
- `stale-list:mcp-category-enum` — inline category list enumerated only **13** of 14 (missing **`tags`**),
  while the "14 categories" count itself was correct. → added `tags` to the list.
Everything else verified clean: agent-providers (6), persistence-schema (7), agent-sessions (7),
monitor-orchestration (11), review-merge (7), butler (7), workflow-engine (6), project-registration (2),
codemods (4), workspaces (5), preferences-config (6), git-integration (4), issues-board (5), board-ui (7,
incl. live `git log --follow BoardPage.tsx` = 718 confirmed). Adjacent non-doc finding (not fixed, out of
scope): `loop.sh:26` *code comment* says `MONITOR_SLEEP` 900s but the real default is 1800s — a stale
in-code comment, the doc is right.
Keys: `stale-count:mcp-tool-total` `stale-list:mcp-category-enum` (both fixed).

S12 insight: a dedicated *constant-claims* lens catches numeric drift that S10's density-counting and
S8's behavior-probing both structurally miss — magic numbers/counts that are individually accurate-looking
but rounded-stale. Two stale counts survived 8 prior rounds because every earlier lens read constants as
*evidence*, never as *claims to be refuted*. This is the productive frontier on a re-run with no code change.

**Convergence status (after R9):** S1–S12 + 4 personas all run. S12 was productive (2 fixes) — confirming
that inventing a fresh lens, not re-running an exhausted one, is the correct response to a "verify again"
with no code change. The constant-claims frontier is now swept; a future re-run should re-invent again or
declare dry. Cadence lenses (S9 drift, S8 run-the-system) remain the standing re-run whenever code lands.
