# Verification model — run ledger

Shared dedup anchor across discover → cover → author runs. Each entry: what ran, on what scope,
what it found, what's still open. The model in this directory is **incremental** — a re-run
updates changed capabilities, it does not rebuild from scratch.

---

## 2026-06-27 — pipeline dry-run (slice: `workspaces` only)

**Scope: 1 of 15 capabilities.** This is a validation slice, not a full model. The other 14
capabilities in `docs/domain/_plan.json` are NOT YET in `_behavior-model.json` / `_coverage.json`.

- **behavior-discovery** (skill validated): produced the `workspaces` capability record — 26
  observable behaviours, 14 entry points, 5 actors, an 11-state lifecycle (14 transitions), 13
  error states, 6 explicit unknowns. Confidence 21 high / 5 medium / 0 low. Live-confirmed the
  unscoped-list 400 read-only against the running server.
- **coverage-intelligence** (skill validated): mapped behaviours against the existing suite —
  19 covered / 2 partial / 5 uncovered; capability score 0.76. Weakest dimensions:
  `state-transition` (4 uncovered) and `error` (3 uncovered) — as predicted. `permission` = N/A
  (single-user/local). Produced `_coverage.json`, `_gaps.md`, `_priorities.md` (8 ROI-ranked
  gap specs through P4).
- **e2e-test-author**: NOT run in the dry-run. The `_priorities.md` backlog is its work order.

### Finding folded back into the skill (this run improved the tooling)
The deterministic candidate filter used during the dry-run matched tests by **slug keyword**
only, so source-importing unit tests (`merge-cascade.test.ts`, `auto-start-followup-setting.test.ts`,
`agent.service.test.ts`) were excluded — making genuine coverage look like gaps. Fixed:
`tools/test-inventory.mjs` now emits `imports`/`import_basenames`; `coverage-intelligence`
Phase 1 + `mapping-brief.md` now build the candidate set as the **union of api-path / route /
source-import** matches. Re-verified: workspaces candidate set 12 → 29 files. The 3 high-value
`uncovered` rows in `_coverage.json` (cascade, plan-gate, reattach) are therefore **suspect** —
a non-dry re-run with the source-matched set may downgrade them to dimension top-ups. Their
`_priorities.md` rows already carry a "verify out-of-candidate tests first" note.

## 2026-06-27 — e2e-test-author run (top gap: P0 cascade.post-merge-followups)

Exercised the third skill end-to-end against the #1 backlog gap. Phase 1 verified the gap is
genuinely uncovered at BOTH e2e and server levels (`merge-cascade.test.ts` only asserts board-
responsiveness + branches-reach-master; `workspace-merge-subservices.test.ts` only covers
conflict/cleanup). Authored `packages/e2e/tests/api/workspace-cascade-followup.test.ts` (green),
then ran the **adversarial refute pass** (3 independent reviewers, P0 quorum).

**Adversarial pass earned its keep** — all 3 returned `needs-fix` on a real correctness defect
the author missed: the test did not ISOLATE the followup cascade from a SECOND, observationally-
identical post-merge path. Fixes applied (test-only): pin `start_mode`=manual +
`dependency_auto_chain`=false to exclude the other path, retry merge on 409 (per-repo merge lock),
harden pref restore, document the global-pref cross-file coupling + serial mode. Re-reviewed the
isolation fix.

### Model corrections folded back (from the review)
- The post-merge follow-up cascade gate is the **`auto_start_followup` pref**, NOT Start Mode
  (the behaviour-model `workspaces.cascade.post-merge-followups` `preconditions` said "Start Mode
  permits auto-start" — that's the gate for the OTHER path).
- There are **TWO** post-merge auto-start mechanisms, run back-to-back
  (`workspace-merge-cleanup.service.ts:70-71`): `maybeAutoStartFollowups` (gated by
  `auto_start_followup`) and `maybeAutoStartUnblockedDependency` /
  `autoStartUnblockedDependencyIssue` (gated by `resolveStartPolicy().postMergeCascade` =
  monitor-mode + `dependency_auto_chain`). The model treated this as one behaviour — it is two,
  with different gates and different WIP/fan-out semantics. `_behavior-model.json` should split
  `workspaces.cascade.*` into `.followups` and `.unblocked-dependency`. Filed.
- New gap added to `_priorities.md`: `workspaces.cascade.partial-blockers-no-start` (the
  multi-blocker `every`-guard, invisible to the single-blocker P0 test).

## 2026-06-27 — full fan-out: discovery + coverage for the remaining 14 capabilities

Completed the model. Ran a combined discover+cover subagent per capability (3 waves of 4–5),
each anchored on its deterministic candidate-test set and writing its own
`capabilities/<slug>.json`, then assembled + rendered deterministically.

- New tooling (dogfood-driven): `tools/candidates.mjs` (per-capability candidate sets via
  source-import ∪ api-path ∪ keyword — the fix from the workspaces dry-run, now at scale),
  `tools/assemble.mjs` (merge per-capability files → `_behavior-model.json` + `_coverage.json`),
  `tools/render.mjs` (regenerate `_coverage-matrix.md` / `_gaps.md` / `_priorities.md`).
- **Model now: 15 capabilities, 273 behaviours, overall functional-coverage score 0.837**
  (210 covered / 37 partial / 26 uncovered; 0 undocumented-implemented / 0 documented-missing —
  see caveat below). Per-capability scores 0.62 → 0.94 in `_coverage-matrix.md`.
- Weakest capabilities: project-registration (0.62 — registration orchestration untested though
  per-stack derivation is dense), mcp-server (0.63 — governance/permission gaps on an
  unauthenticated surface). Strongest: git-integration / issues-board (0.94).
- Top P0s in the consolidated `_priorities.md`: `project-registration.resolve.defaultBranch`
  (#772 never-null guarantee untested) and `mcp-server.govern.disabled-tools` (the only authority
  knob on the MCP surface, untested). 59 ranked gaps total.
- High-signal findings raised by the per-capability agents (verify before acting): manual `/merge`
  may bypass the verify/smoke gate (review-merge unknown); provider env-strip credential-bleed
  guard untested (agent-providers); cascade-walk can't catch a future unseeded child table
  (persistence-schema); divergence guard may fail-open on malformed Bullseye JSON (preferences).

## 2026-06-27 — e2e-test-author wave 1: closed 6 top-backlog gaps

Ran the generator over the 6 highest-ROI, deterministic-to-test gaps (parallel author subagents),
then a 1-refuter-each adversarial pass. **4 of 5 new tests returned needs-fix** and were fixed
before landing — the refute pass again earned its keep.

- **New tests (all green, 18 cases / 5 files):** registration-resolve-default-branch (P0),
  disabled-tools (P0), build-spawn-env-strip (P1), issue-cascade-completeness.repo (P1),
  propose-transition (P1). `preferences-config.resolve.start-policy` was a **false gap** (already
  fully covered; candidate filter hadn't credited the colocated test) — added `@covers` tag only.
- **Coverage: 0.837 → 0.852** (covered 210→215, partial 37→35, uncovered 26→23). Backlog 59→53.
- **Defects the refuters caught (representative):** registration over-declared dims and never built
  the real #772 null path (added detached-HEAD case); disabled-tools "call refused" was a
  false-confidence smoke check (random-UUID isError ≠ gate-refusal); env-strip credited a DEAD
  branch (helpers.ts:161-163); propose-transition fired a REAL fetch to :3001 mid-test.
- **3 product bugs filed (board #926/#927/#928):** MCP disabled-tools no trim/case (security);
  buildSpawnEnv dead branch + CLAUDE_CODE_ credential bleed (security); Node-26 libsql `:memory:`
  loses tables across `db.transaction()` (server cascade suite baseline-red — independently
  reproduced). These are the pipeline doing its real job: surfacing product issues, not just tests.
- **Follow-up gaps logged** (not yet authored): workflow-engine maxVisits/terminal via the MCP
  wrapper; cascade-delete set-null-referrer + cascade-FK-table-in-fresh-DB sub-cases.

### Still open
- **Phase 2 requirements-mapping NOT yet run** for any capability — so the `documented-missing`
  / `undocumented-implemented` buckets are empty by *omission of the pass*, not by verified
  absence. This is the next highest-value step (mine PRD/ADRs/constraints/tests → behaviours).
- Per-capability summaries report coverage from each agent's candidate slice; a cross-capability
  dedup pass (a test crediting two capabilities) hasn't run.
- Author down the backlog with `e2e-test-author` (1 of 59 gaps closed so far: the workspaces P0).
- `_behavior-model.json` should split `workspaces.cascade.*` into followups vs unblocked-dependency
  (the dual-path correction from the cascade authoring run).
