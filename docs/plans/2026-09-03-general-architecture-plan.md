# General architecture improvement — modernization plan for agentic-kanban (no goal given)

No product goal was set for this run. The plan was produced with the `modernization-plan` skill in
**general mode**: the direction is derived from what the repo has already written down it wants to
do next (§ 0), joined with what the `code-metrics` engine measured (§ 1–2), and the plan is a
sequence across every level — module boundaries and kernels down to afternoon-sized quick wins —
with exit criteria that can fail. This document is the *plan*; nothing in it has been implemented.

It does not supersede the three goal-directed plans of 2026-09-01 (external tracker, PR/CI
delivery, shared database). It **prepares** them: each of those is inherited here as an implied
goal (D8a–c), and § 5 says which phase of this plan makes which of theirs cheaper.

## Provenance
- Mode: **general** (no goal given) — direction sources read: `docs/proposals/2026-09-03-dev-board-vs-deployed-board.md`, `docs/proposals/2026-09-01-verification-cadence.md`, `docs/plans/2026-09-01-*.md` (three), `docs/plans/2026-08-26-team-capable-modernization-plan.md`, `docs/decisions/005,006,007,010,013,016,017`, `docs/package-boundaries.md`, `CONTINUE.md` (2026-09-02 passes), `BACKLOG.md` (export of 2026-08-24, stale — the live board has 2 open tickets: #999, #1000), `scripts/board-monitor/objective.md`, `CLAUDE.md`.
- Repo / commit: analysed at `a1714e1fa5` (2026-09-03 12:44); HEAD at delivery `02102afd6c`, 2 `docs:` commits later, `docs/**` excluded from analysis — the snapshot describes HEAD's code exactly (§ 6 F19). Metrics snapshot: `code-metrics analyze . -o <scratch>/out --days 180`, 2026-09-03 11:20 UTC, 3,161 files, 1,832 production.
- **Graph reach**: `resolution_coverage` ts imports 8,784 / 8,790 = **0.9993** — graph numbers usable as stated [src: analysis.json → provenance.resolution_coverage.languages.ts.imports.resolved_share] · channels unmeasured: py (0 seen), calls **absent** (`absent:no_call_resolution_channel` — every "nothing calls X" here is a grep, not a metric) · `analyze` keeps type-only imports, `graph --dependents-of` erases them; dependents counts below are from `graph --stats` and say so.
- Prior plan for this goal: none (the three 2026-09-01 plans are goal-directed; this plan extends them, see above).
- Direction framing: § 0–1 (12 recorded items, 15 evolvability rows, 13 watch-list entries) · Seams: 3 · Subagents: 3 seam agents (**ran 1 concurrent** — `fleet gate --count 2` said "room for 0" throughout, 0.9–2.0 GB usable, swapping; each agent was released only after the previous finished) · all three reports `prior-plan-informed` (they read `direction.md`, which digests the 2026-09-01 plans; every inherited claim is marked and re-derived in § 6 or carried as `inherited`).
- Skeleton review (step 5): one cheap subagent (75,828 tokens, 2 min) over the one-page skeleton before the phases were written out — it moved the first-outcome marker (P1.4 was a phantom: the capacity snapshot already carried `hold` and both consumers read it), two insertion points (the heal ticket into the existing nightly sweep, not a 24th service; the base-advance funnel out of `shared/lib` into the server), pulled the log-only advance record forward from Phase 3 to Phase 2, and named four recorded items with no item (D1 boot-from-dist, D3's WIP clamp, D11's occupancy fallback, D4 out of scope) — all integrated in § 5 before any prose was written. Second skeleton pass (87,021 tokens, 3 min), scoped to what the re-cut introduced: phase order holds; one insertion point moved again (P1.4's clamp from the pure `resolveWipLimit` to the cycle's `wipLimitFor`, after the #908 overflow check); three in-phase plumbing gaps added as bullets (P1.10 threads the policy into the sweep; P2.3 writes through the `issues` owner and drops "outside WIP" to "top priority" because no exemption mechanism exists; P2.4 must persist `impactSelection` first). Integrated; a third pass was not run — the remaining movement was inside phases.
- Exit-criteria pass (6b-0): one cheap subagent (91,774 tokens, 6 min) over § 5's items, do-not-build lines and criteria tables with the A1–A10 list, running the named commands: **4 of 25 NOT-FALSIFIABLE** — E0.1 (A5: targets declared at today's values are ✅ by construction), E2.4 (A2: the discard count had no phase-start value), E4.1 (A5/A8: re-declared targets are green by baselining), E4.2 (A9: an "or the team decided" arm) — all four replaced before the rubric round; plus five miswired grep clauses (E1.4 ×2, E1.7's prop count 16→17, E3.1, E3.3) and one already-true clause (E0.3's level dimension) corrected in place.
- Refuted / weakened facts: **8 refuted, 3 weakened, 10 confirmed** of 21 attacked (§ 6) · Adversarial review: **2 rounds × N = 1** (generalist; round 2 narrow on the Phase-1 re-cut + R7), **13 majors: 13 integrated / 0 rejected / 0 shortcoming** (§ 7) · phases re-cut: **no** — the order and the marker phase held through both rounds; the marker's *content* changed twice (§ 7) and round 3 was not run (§ 8).
- Cost: ≈ 3 h 45 min wall clock · 8 subagents, one at a time — 3 seam (174,837 + 151,356 + 214,903), 2 skeleton passes (75,828 + 87,021), 6b-0 (91,774), 2 rubric rounds (189,385 + 155,280) = **1.14 M subagent tokens** · 34 `code-metrics` invocations (1 analyze, 12 query lenses, candidates, refactor ×3, graph ×8, scorecard, patterns measure, plan-claims / plan-decisions / signal-usage at the end).
- Self-check (§ 6c): `plan-claims` (final, after both rounds) — 98 load-bearing claims, **32 unsourced (32.7 %)**, 3 of 4 cited snapshot fields resolve (the fourth, `files[].functions[]`, is a path the resolver does not walk; the value was read by script, § 6 F17) · `plan-decisions` — 5 phases, first outcome phase 1 (declared), 98 files touched, 9 do-not-touch, 28 items / 25 criteria · `signal-usage` — 2 of 103 registered metrics cited **by key** (`refactor_first` ×18, `knowledge_transfer` ×2); the plan cites lenses and files rather than registry keys, so this is a floor on use, not use.
- NOT measured: class metrics (0.5 % of SLOC in classes — N/A); fat controllers (function-routed Hono, N/A); `rework` (94.5 %, a `fix:`-prefix convention artifact — cited only as such); runtime performance; the 61 % harness share of commits (second-hand, re-derived as 49 % by a weaker classifier, neither is a criterion); the function-level cyclomatic figures on `.tsx` files (§ 6 F17 — the engine's function span over-extends on TSX; file-level risk stands, branch counts do not).

## 0. Recorded direction — what the team already intends to do

Written from the documents **before** the metrics were opened, as the mode requires. The board is
drained on purpose (`objective.md`: "DRAIN THE BACKLOG … Do NOT refill"), so the direction lives in
the proposals, plans and decisions rather than in tickets.

| id | Source | What the team intends next | Where it will land |
|---|---|---|---|
| D1 | proposal 2026-09-03 § A | Split the **stable board** (built artifact from `dist/`, own DB via `KANBAN_DB_URL`, ports 3001/5173) from the **dev board** (3101/5273); a `promote` script: nightly-sweep-green → tag → fast-forward → build → migrate → restart → smoke → rollback | startup (`server-start.ts`, `startup-tasks.ts:171 runMigrations`), DB path resolution, skill bundling, `/health` |
| D2 | § B | **Land-then-heal**: enable `redBasePolicy: allow-file-debt-ticket` (decision 017); nightly full sweep files ONE `heal` ticket; gate-discard rule (#979/#986): do not discard when the base moved only by commits outside branch-diff ∪ impact selection; map-rebuild commits off master | `workspace-merge-gate.ts`, `merge-gate-evidence.ts:31-33`, `monitor-cycle.ts:337-364`, `monitor-test-impact-map.ts` |
| D3 | § C | **Capacity as a gate signal**: WIP limit and gate start read `fleet gate`; nothing starts under threshold | `shared/lib/machine-capacity.ts:127`, `monitor-auto-start.ts:427`, `gate-quiesce.ts:81` |
| D4 | § D | Producer side: `BACKLOG_FLOOR` 15, refill via `backlog-refill` + `ticket-enhancer`, grouping via `coupled_with` (#661) | policy flips; plugin loops unchanged |
| D5 | § E | **Harness budget** (≤ 1 of 3 builders on harness tickets) and an **audit** of the always-run guard suites (168 files carry `@gate:always-run`) and ratchet tests (38 `*ratchet*.test.ts`): merge same-property guards, drop never-red ones | `packages/*/__tests__`, `pre-merge-gate-tier.ts:263`, `scripts/test-mine.mjs:312-374` |
| D6 | § 6 | **Profile roster** (pool / reserve / forbidden), quota read-ahead, worker attestation — "Settings → Agent, one preference", global + per-project override; `forbidden` refuses rather than clamps | `settings/AgentSettings.tsx`, `provider-config-resolution.ts:125-141`, `auth-rotation-ring.ts:266`, `worker-fleet.service.ts:499` |
| D7 | verification-cadence step 5; CONTINUE 2026-09-02 | Measure the impact-selection **miss rate**; corpus accrues ≈ 1 base-sweep row/day; revisit `iterate` with data | `test-impact-outcome.service.ts:789,872`, `base-branch-health.service.ts:417` |
| D8a | plan 2026-09-01 external tracker (implied goal) | Tracker as source of truth — needs the issue write API and the status vocabulary explicit | `issue.service.ts:386,483`, `routes/issues.ts`, status consts, exit-workflow's 17 broadcasts |
| D8b | plan 2026-09-01 PR/CI delivery (implied goal) | A work item completes when a PR merged with CI green — needs the merge tail and base-advance paths enumerated, cards render PR state | merge drivers, `IssueCard.tsx` |
| D8c | plan 2026-09-01 shared database (implied goal) | One shared database — needs one DB-handle port, the migrator behind it, per-instance state separated | `server/db/index.ts`, `mcp-server/db.ts`, `shared/lib/db-client.ts`, `manual-migrate.ts` |
| D9 | `docs/package-boundaries.md` (#730 verdict) | **Rejected, not to be re-proposed**: splitting `shared` by consumer; vertical slices. The real gap: nothing *enforces* the wire contract (#780/#806) | `shared/types/api.ts`, `apiResponseSchemas.ts`, `routes/*-body-schemas.ts` |
| D10 | decisions 005 / 013 / 017; CLAUDE.md | `statusId` is a derived view, `currentNodeId` decides; workspace mirror columns dual-write until stage 4; every partial refactor adds a shrink-only ratchet; git only through `git-exec.ts`; provider default = the Strategy Bullseye pref | constraints on every phase |
| D11 | CONTINUE 2026-09-02 | Un-ticketed: `occupancyFromStatsJson` fallback still cumulative; `sessions.stats` had two read-modify-write paths (#1002 fixed one chain — "may recur"); #1004 "nothing on screen says so" | `lib/context-window.ts:97`, `session-manager/broadcast.ts:101`, workspace panel |
| D12 | `git log --since=2026-08-25` | 261 non-merge commits: 121 `fix:` · 29 `feat:` · 21 `chore:` · 18 `docs:` · 9 `refactor:`; the proposal reads 61 % of them as harness work | — |

## 1. Direction as evolvability delta

No goal was given. The direction below is **derived**: the left half of every row is what the
engine measured, the middle is what the team has already written down that it intends to do
(`D-ids` from the *Recorded direction* table in § 0), and a structural fact that blocks nothing
recorded is not a row — it is on the watch list underneath. Rows span both levels on purpose.

| # | Level | Structural fact | What it costs today / recorded work it blocks | Quality demanded | Seam |
|---|---|---|---|---|---|
| R1 | architecture | `client ↔ server` co-change **1,055** change sets, Jaccard 0.370, with **no static import edge** — a hidden dependency [src: module-crime.txt → Hidden dependencies]; the pair is 35 % of all cross-module work [src: tangle.txt] | Nothing enforces the wire contract the two ends share — D9 (`docs/package-boundaries.md`, #780/#806): 0 `zValidator` in the route files, 275 of 292 outbound paths unvalidated *(second-hand, re-derived in § 6)*. Every client-facing change pays it; D8a needs the issue DTO explicit before a tracker can project into it | explicitly contracted | S1 |
| R2 | architecture | `mcp-server ↔ server` 206 / 0.097 and `client ↔ mcp-server` 123 / 0.064, both hidden; `mcp-server` containment **23 %**, `shared` 35 % [src: module-crime.txt, tangle.txt] | The status vocabulary and the issue write shape are kept in sync by hand across three packages *(second-hand from the 2026-08-26 plan, re-derived in § 6)*; D8a's translation layer and D4's plugin loops both sit on it | explicitly contracted | S1 |
| R3 | architecture | boundary `server ↔ shared` leakage **0.48** (9 file pairs) → `introduce_facade` [src: boundaries.txt]; `routes/issues.ts ↔ shared/types/api.ts` 58 shared commits / 30 % [src: coupling.txt] | D8a, D8c. D9 has already rejected splitting `shared` (2.3 % upper bound) — so the fix is the *contract*, never the package layout | explicitly contracted | S1 |
| R4 | architecture | kernel `shared/src/schema/index.ts` **585** dependents, fan-out 47; `server/src/db/index.ts` 254 [src: graph.txt → Most depended-on]; the repo's **only** import cycle — 9 files, all in `shared/schema` [src: cycles.txt] | D1 (the stable board runs migrations from `dist/`), D8c (one DB-handle port), every schema change (table-width ratchet, decision 013) | versionable kernel | S1 |
| R5 | architecture | `startup/exit-workflow.ts` risk **0.872** (#3 of 344), fan-out 39, prescribed `introduce_event` (8 cross-module calls); `handleReviewSessionExit` / `handleBuilderSessionExit` CC 30 each [src: refactor_first.txt, candidates.txt, functions.txt] | D2 — the heal ticket and the discard rule both react to session exits and gate outcomes; D8b's merge tail starts here | observable, locally reasoned | S2 |
| R6 | architecture | `startup/monitor-auto-start.ts` 0.770, `split_responsibility` → 6 groups, one of which (`autostartskipreason`: `hasFleetOverflowCapacity`, `isHostSaturated`, …) *is* capacity; `startup/monitor-cycle.ts` 0.765 → 4 groups [src: candidates.txt] | D3 (capacity as a gate signal inserts exactly into that group), D2, D4 | contained | S2 |
| R7 | architecture | `server-start.ts` 0.839 (`startServer` CC 17, churn 399), `startup/startup-tasks.ts` 0.714 fan-out 39, `startup/monitor-setup.ts` 0.690 fan-out 32 [src: refactor_first.txt, graph.txt → Most dependencies] | D1 — build-and-start from `dist/`, migrations, `/health`, promote + rollback all pass through startup | locally reasoned | S2 |
| R8 | architecture | `services/pre-merge-gate.service.ts` 0.701, fan-out 31, co-change 30 % with `scripts/test-mine.mjs` — a `server ↔ scripts` crossing [src: coupling.txt]; `scripts` module risk 0.318 with the highest churn trend, +0.26 [src: module-crime.txt]; `workspace-merge.service.ts` 0.794, `merge-workflow.ts` 0.710 [src: refactor_first.txt] | D2 (discard rule, `allow-file-debt-ticket`), D5 (168 `@gate:always-run` files + 38 ratchet suites are a per-merge tax the proposal wants audited), D7 (`test-impact-outcome.service.ts` at 1014 lines against the 1000-line gate) | contained, ratcheted | S2 |
| R9 | architecture | business logic in adapters **35 %**; client centre of gravity 0.215 — 10,402 decision points in 337 frontend files [src: layer-fit.txt]; 435 files with a function over CC 10 (the scorecard's only 🔴, defaulted target) [src: scorecard.txt] | Every client change under D6, D8b, D11 pays it; the client has no domain layer to move logic into | locally reasoned | S3 |
| R10 | architecture | the provider triplet co-changes 63–73 % (`claude-provider ↔ copilot-provider` 73 %, `↔ codex-provider` 67 %, each ↔ `types.ts` 67–69 %); duplication 14 % [src: coupling.txt, scorecard.txt] | D6 — the roster and worker attestation touch every provider; three copies of one shape means three edits per change | locally reasoned | S3 |
| R11 | quick win | `client/components/SettingsPanel.tsx` risk **0.906** (#1 of 344), `loadDeferred` CC 24, churn 435 [src: refactor_first.txt, functions.txt] | D6 is specified as "Settings → Agent, one preference" — the roster UI lands in the repo's riskiest file | locally reasoned | S3 |
| R12 | quick win | `client/components/WorkspacePanel.tsx` 0.869, `fetchWorkspaces` CC 30 × churn 371 = the **#1 function hotspot** in the repo [src: functions.txt]; `IssueCard.tsx` 0.769 ↔ `IssueDetailPanel.tsx` 0.801 co-change 33 % [src: coupling.txt] | D11 (occupancy fallback still cumulative; #1004 "nothing on screen says so"), D8b (cards render PR/CI state) | locally reasoned | S3 |
| R13 | quick win | `services/issue.service.ts` 0.783 → 4 groups + `introduce_event` (5 calls); `routes/issues.ts` 0.776 → 2 groups, 81 functions [src: candidates.txt] | D8a — the issue write API is the thing a tracker adapter wraps; #831's remainder rule says split by *consumers*, not identifiers | locally reasoned | S1 |
| R14 | quick win | `client/routes/BoardPage.tsx` churn **735** in 180 d — the hottest file [src: summary.txt] — `split_responsibility` → 3 groups (issue / requestidlecallback / boardquerykeys), 99 functions, fan-out 41 [src: candidates.txt] | Every board feature under D8b and D11 lands in it; a change here is a change in the file with the widest client fan-out | locally reasoned | S3 |
| R15 | quick win | 103 `split_responsibility` moves prescribed now that the snapshot is deep enough (#831 found 0 on the shallow one); `split-responsibility-ratchet.test.ts` pins **17** files shrink-only [src: refactor-all.txt; `BASELINE` in that test, counted in § 6] | D10's convention: every remainder is a shrink-only ratchet; the ratchet exists, the re-derive command now works — the remainder is unblocked | ratcheted | cross-seam |

**Watch list** — red in the metrics, on no recorded item; reported, not scheduled. A reviewer
reads this first (§ 7, R1) to check the mode did not degenerate into "fix everything red".

| File / finding | Number [src] | Why it is not a row |
|---|---|---|
| `client/components/Layout.tsx` | 0.884, `handleAddRepoSubmit` CC 34 [src: refactor_first.txt] | the add-repo flow; no D-item lands there (D10's relocate rule is a CLI path). Re-decide if D1 needs project registration UI |
| `client/components/BoardToolbar.tsx` | 0.832 [src: refactor_first.txt] | hot, off every seam — same verdict the two prior plans reached |
| `client/components/ButlerView.tsx` | 0.777, split → 4 [src: candidates.txt] | butler UI; nothing recorded touches it |
| `CreateIssuePanel.tsx` ↔ `CreateIssueForm.tsx` | 0.763 / 0.758, co-change 51 % [src: coupling.txt] | `issue-form-duplication-ratchet` already pins it; D4 refill is a policy flip, not a form change |
| `DiffViewer.tsx`, `TableView.tsx`, `BoardStats.tsx`, `OnboardingWizard.tsx` (CC 64), `BacklogView.tsx` | 0.737 / 0.707 / 0.681 / — / — [src: refactor_first.txt, refactor-all.txt] | hot or split-prescribed, on no recorded work |
| `services/plugin-loop.service.ts` | 0.737, CC 44 [src: refactor_first.txt] | D4 turns refill *on*; it does not change the loop engine |
| `services/project.service.ts` | 0.752 (#20), computed split projectid / repopath / setprojectarchived [src: refactor_first.txt, candidates.txt] | named by both the tracker and the shared-database plans (D8a, D8c) as *their* hot-on-seam file; this plan leaves its split to them so two plans do not cut one file. Added in round 1 — the draft had no verdict on it |
| `startup/stranded-review-reconciler.ts` | 0.685, CC 45 [src: refactor_first.txt] | on no D-item; touched only if S2's event extraction reaches it |
| `services/merge-queue.service.ts` | 0.689, CC 38 [src: refactor_first.txt] | the 2026-09-03 proposal § 5 explicitly *rejects* merge-queue batching — leave it |
| `routes/projects.ts` 0.755 (churn 431), `routes/workspace-actions.ts` 0.789, `routes/workspaces.ts` 0.776, `workspace-crud.service.ts` 0.698, `workspace-summary.service.ts` 0.727, `session-lifecycle.ts` 0.731 | [src: refactor_first.txt] | route/CRUD hotspots; D9's inbound-validation slice touches routes *additively* (a validator per handler), which is not a reason to restructure them |
| rework 94.5 % (agent 95.1 % / human 93.8 %) | [src: rework.txt] | a **convention artifact** — this repo prefixes follow-ups `fix:`; not evidence of anything and cited nowhere else in this plan |
| 1 god table, 1 relationship with no index, 1 layer violation (`ButlerChrome.tsx`), 1 upgrade blocker | [src: scorecard.txt, layer-fit.txt] | all against *defaulted* targets; none on recorded work |
| 279 orphan files; PowerShell/Shell test-convention gaps | [src: graph.txt, summary.txt] | measurement hygiene for `.codemetricsrc [tests]`, not architecture |

## 2. What the metrics say about the ground we will build on

- **Graph reach is usable as stated.** TypeScript imports resolve 8,784 of 8,790 (0.9993)
  [src: analysis.json → provenance.resolution_coverage.languages.ts.imports.resolved_share]; the six
  unresolved are `bin/*.js → ../dist/*` and a `.js`-suffixed sibling. There is **no call-resolution
  channel** [src: analysis.json → provenance.resolution_coverage.calls], so every "nothing calls X"
  below is a grep. `analyze` keeps type-only imports, `graph --dependents-of` erases them — the plan
  quotes `graph --stats` counts and says so.
- **The kernel is the schema.** `shared/src/schema/index.ts` has 585 dependents and a fan-out of 47
  [src: graph.txt]; the only import cycle in 3,161 files is nine schema modules referencing each
  other [src: cycles.txt]. Every table is a whole-schema import away from every consumer.
- **The three hidden dependencies are the three process boundaries.** `client ↔ server` (1,055),
  `mcp-server ↔ server` (206), `client ↔ mcp-server` (123) co-change with no import edge [src:
  module-crime.txt]. The repo's own verdict (D9) is that the layout is right and the *enforcement*
  is missing; the metrics agree — `patterns measure` finds 0 rule violations and 100 % allocation
  across 23 pattern elements [src: patterns.txt], so the code is consistently shaped and still
  changes in lockstep.
- **The server's hot files are the drivers, and the engine has already computed their seams.**
  Of the top 40 `refactor_first`, 11 are `startup/*` or merge/gate services [src: refactor_first.txt];
  `monitor-auto-start` (6 groups), `monitor-cycle` (4), `issue.service` (4), `routes/issues` (2),
  `BoardPage` (3) carry `split_responsibility` prescriptions and `exit-workflow`, `monitor-auto-start`,
  `issue.service` carry `introduce_event` [src: candidates.txt]. 191 moves in all: 103 splits, 60
  events, 27 relocations, 1 facade [src: refactor-all.txt].
- **The client is where the logic is, and it has nowhere lower to go.** 35 % of decision points sit
  in adapters; the client's centre of gravity is 0.215 against the server's 0.600 [src: layer-fit.txt].
  Four of the top seven hotspots are client shell components [src: refactor_first.txt].
- **Ownership is one person.** Truck factor 1 in every module, dominant share 58–83 %
  [src: module-crime.txt → Ownership]; 34 knowledge-transfer files [src: summary.txt]. Descriptive
  — it routes no phase, but it is why the safety net in Phase 0 is characterisation tests and not
  review.
- **What the scorecard cannot say.** 0 of 26 targets are declared [src: scorecard.txt]; the 88.3
  composite is advisory and no exit criterion rests on it until Phase 0 declares the handful this
  plan cites. Class-level metrics are N/A (0.5 % of SLOC in classes) [src: god-objects.txt].
  Rework (94.5 %) is a `fix:`-prefix convention artifact [src: rework.txt] and is cited only as such.
- **The verification harness is a measured cost.** 168 files carry `@gate:always-run` and 38 are
  `*ratchet*.test.ts` [src: grep, § 6]; the proposal counts 61 % of the last 261 commits as harness
  work [src: docs/proposals/2026-09-03 § 1, second-hand — re-derived in § 6 by a subject-keyword grep as 127 of 261 = 49 %, a weaker
  classifier than the proposal's diff reading; the subject mix is 121 `fix:` / 29 `feat:` / 21
  `chore:` / 18 `docs:` / 9 `refactor:`]. Neither figure carries an exit criterion.

## 3. Seams and their components

Three seams, from the rows' seam column. Every component below was read by a seam agent; the
`file:line` anchors are theirs and were spot-checked in § 6. Class: **kernel** (top depended-on /
blast radius ≥ 10 %) · **hot-on-seam** (in `refactor_first` or carrying a prescribed move) ·
**cold-on-seam** · **contract** (co-change with no import edge).

### S1 — wire contract & schema kernel

| Component | Files | Role | What the recorded work needs from it | Class | Size |
|---|---|---|---|---|---|
| Wire DTO barrel | `shared/src/types/api.ts` (56 lines, `export type *` over 32 files in `types/api/*`) | the hand-authored contract, **erased at runtime** — 265 client files `import type` from it [src: grep, seam 1] | D9 enforcement, D8a issue DTO | contract (58 commits / 30 % with `routes/issues.ts` [src: coupling.txt]) | S per batch |
| Outbound registry | `client/src/lib/api.ts` (158 dependents [src: graph.txt]), `lib/apiResponseSchemas.ts:639-729` (**52** entries), `__tests__/api-response-validation-baseline.ts` (**207** unvalidated) | runtime parse at `apiFetch`; ratchet derives the called set from the AST | D9 | cold-on-seam | S–M |
| Inbound door | `middleware/parse-body.ts` (`parseJsonBody(c, schema)`, #512), 28 `routes/*-body-schemas.ts`, `route-body-validation-ratchet` (`BASELINE_TOTAL = 58`; `issues.ts: 2` → `routes/issues.ts:148`, `:792`) | zod at the door; 0 `zValidator` | D9 | cold-on-seam | S per file |
| Issue write API | `services/issue.service.ts` (932 lines; factory closure `createIssueService:159-232` returning 18 functions; `SHARED_ISSUE_UPDATE_FIELDS` from #987), `repositories/issue-service.repository.ts` | the write API a tracker adapter would wrap — but `issues` has **≥ 21 writer files in 3 packages** and no declared owner (§ 6 F11, F15) | D8a | hot-on-seam 0.783, `split_responsibility` → 4 (**rejected as a name-cluster** — § 3 note) | M |
| Issues router | `routes/issues.ts` (827 lines, 55 routes) | REST surface; `:355-420` (related-issues / touched-files) is the one real extractable slice of the computed 2-way split | D9, D8a | hot-on-seam 0.776 | S |
| Status vocabulary | `shared/lib/project-statuses.ts:30-38`, `status-transitions.ts:141-149` (`CANONICAL_ISSUE_STATUS_NAMES`), `status-view.ts`; **41 client files** + **7 mcp tool files** + 64 server files re-list the literals; 3 client files import the shared modules [src: seam 1 grep, § 6 F16] | declared twice, consumed almost nowhere | D8a translation layer | contract (`client ↔ mcp-server` 123 hidden [src: module-crime.txt]) | M sweep |
| Schema kernel | `shared/src/schema/index.ts` (99 lines, 44 tables; 585 dependents, fan-out 47 [src: graph.txt]); the 9-file `relations()` cycle [src: cycles.txt] | Drizzle namespace, `import * as schema` demanded by `drizzle({schema})` (`server/db/index.ts:51`) | D10 width ratchet (`workspaces` 38 columns, threshold 30), D8c | **kernel** — the cycle is benign and stays | — |
| DB handle | `server/db/index.ts:28-52` (2 handles), `db/backup.ts:137,196,368`, `mcp-server/db.ts:42,50`, `shared/lib/db-client.ts:92` (`createClientWithPragmas`) | **7** `createClient(` sites in 4 files; one pragma policy shared | D8c one port, D1 | kernel (254 dependents) | M |
| Ownership / width guards | `repository-table-ownership` (owners: `projects`, `sessions` only), `status-write-ratchet` (6 raw writers), `status-read-ratchet` (27 files), `workspaces-table-width-ratchet`, `repository-projections-ratchet` (12) | shrink-only baselines | D5, D10 | cold-on-seam | S |

Note on the prescribed split of `issue.service.ts` (issueerror / getissueprojectid / statusname /
contractissuerow): the groups are keyed on identifiers the functions *mention* (`IssueError` is
thrown by 10 of them). By consumer the file has four real parts — the write API
(`createIssue … updateIssuesBulk`, consumed by five callers), the tag/artifact delegates
(`:817-841`), `contractCoupledIssues` (`:557-668`, the one cluster the engine got right), and
`getEnrichedWorkspaces` (`:705-797`, a read projection) — and the engine's line would separate
`updateIssue` from `updateIssuesBulk`, which #987 just unified. Same verdict as #819/#831 reached
on three of four files: read the consumers, not the identifiers. The plan uses the consumer cut.

### S2 — monitor, merge & startup drivers

| Component | Files | Role | What the recorded work needs from it | Class | Size |
|---|---|---|---|---|---|
| Exit workflow | `startup/exit-workflow.ts` (655 lines; was 1,048 before `33741fbba9`), `startup/exit/*` (8 files) | session exit → review / gate / arm / auto-merge; **17** `broadcast` sites [src: § 6 F6] | D8a, D8b | hot-on-seam **0.872** #3; `introduce_event` — **no landing site** (§ 6 F8) | L |
| Auto-start | `startup/monitor-auto-start.ts` (989 lines), `monitor-start-holds.ts`, `monitor-skip-attribution.ts`, `monitor-start-scoring.ts` | WIP / capacity / dependency-gated starts; `readMachineCapacity()` at `:957` → `isHostSaturated` `:427` | D3 | hot-on-seam 0.770; split → 6 — **4 groups are interface fields and a 15-line adapter**, 2 real (`runInProgressBackfill:627`, `runTodoPull:736`, `buildDependencyGate:542`) | M |
| Monitor cycle | `startup/monitor-cycle.ts` (960 lines), `monitor-cycle-actions.ts`, `monitor-setup.ts` | per-workspace state machine; `hasStaleBaseWithCommits` / `hasMovedBaseNoCommits` `:337-364` are the base-moved predicates D2 needs | D2, D3 | hot-on-seam 0.765 / 0.690; split → 4 — half real (`board_changed` handlers `:444-790`, the predicates) | M |
| Gate | `services/pre-merge-gate.service.ts` (fan-out 31), `pre-merge-gate-tier.ts`, `merge-gate-evidence.ts`, `verify-tunables.ts`, `gate-quiesce.ts` | verdict + evidence; steers `test-mine.mjs` through **10 `KANBAN_*` env names + 2 regexes duplicated by hand** (`tier.ts:245-248` ↔ `test-mine.mjs:281,304`), held in lockstep by 22 test files [src: § 6 F4, F5] | D2, D5, D7 | hot-on-seam 0.701 | M |
| Merge drivers | `startup/merge-workflow.ts`, `auto-merge-orchestrator.ts`, `services/workspace-merge*.ts`, `merge-executor.service.ts`, `merge-train.service.ts`, `workflow-fork.service.ts`, `worker-remote-sync.service.ts` | landing a branch — **5 base-advance sites**, 3 of them outside `runMergeCore`, all on `advanceRefWithCas` (§ 6 F7) | D2 (`workspace-merge-gate.ts:478-540`), D8b | hot-on-seam 0.794 / 0.710 / 0.692 / 0.689 | L |
| Startup | `server-start.ts` (`startServer:32`, `BACKGROUND_SERVICES` loop `:149`), `startup-tasks.ts:171 runMigrations`, `background-services.ts:74` (**23** entries) | boot, migrations, lifecycle registry — the one place a new reconciler plugs in without touching `server-start.ts` | D1, D2 | hot-on-seam 0.839 / 0.714 | M |
| Outcome ledger | `services/test-impact-outcome.service.ts` (**928** lines — not 1,014, § 6 F2), `base-branch-health*.ts` | miss-rate corpus; `recordVerifyGateOutcome:789`, `recordBaseSweepOutcome:872` | D7 | cold-on-seam | S |
| Risk posture | `services/risk-posture.service.ts:123` | emits `redBasePolicy` — which **nothing reads** (§ 6 F1) | D2 | cold-on-seam | S |
| Runner | `scripts/test-mine.mjs` (1,656 lines), `scripts/check-god-modules.mjs:37` (`MAX_LINES = 1000`; a **second copy** of its baseline lives in `shared/__tests__/max-file-size.test.ts` with a parity test at `:460`) | the verify runner and the god-module gate | D5 | `scripts` module risk 0.318, trend +0.26 [src: module-crime.txt] | M |

### S3 — client shell & provider selection

| Component | Files | Role | What the recorded work needs from it | Class | Size |
|---|---|---|---|---|---|
| Settings shell | `client/components/SettingsPanel.tsx` (530 lines, **11 hand-built tabs** `:334-505`), `settings/AgentSettings.tsx` (354 lines, **16 props** whose data SettingsPanel fetches), `hooks/useProjectProviderControls.ts` | the agent tab writes the Bullseye, the allowlist and the global profile | D6 roster editor | hot-on-seam **0.906** #1; `fetch-in-effect` baseline 3 | M |
| Settings registry | `shared/lib/settings-registry.ts:29` (`SettingDef = {type, default}`, 77 entries) | type/default only — no label or section, so only `AppearanceSettings.tsx` renders from it | D6 "one preference" | cold-on-seam | S |
| Provider resolution | `provider-config-resolution.ts:93-141`, `project-runtime-config.service.ts`, `strategy-objective.service.ts:101,169`, `effective-config.service.ts:54`, `shared/lib/{strategy-policy,profile-allowlist}.ts` | a **12-step precedence chain** (explicit choice → CLI → Bullseye → workspace-baked → global → butler → workflow node → MCP → allowlist clamp → rotation ring → worker placement → `narrowProviderName` default); the allowlist clamps **last** at `:125-141` | D6 roles must be applied where the clamp is, as refuse-not-clamp | contract (CLAUDE.md:142 "single source of truth" holds for the *default* only) | M |
| Rotation ring | `auth-rotation-ring.ts:266`, `session-launch-helpers.ts:148` (`resolveProviderRotation` renames the launched profile to `"default"`, `:175-178`) | reactive cooldown + Bullseye retarget (#973) | D6 quota read-ahead | cold-on-seam | M |
| Worker dispatch | `worker-fleet.service.ts:499,681`, `agent-remote.service.ts:26,575` | a worker "authenticates with its own local login" — no attestation | D6 | hot-on-seam 0.682 | M |
| Provider triplet | `agent-provider/{claude,codex,copilot,pi}-provider.ts`, `types.ts:77` (3-method interface), `helpers.ts` (527 lines) | 8 of 20 commits were shotgun edits touching all four identically — that *is* the 63–73 % co-change; residue ≈ 25 lines/provider | none directly | contract | S |
| Session lifecycle | `session-manager/session-lifecycle.ts` (988 lines, five "back under 1000" refactors), `broadcast.ts:101` (#1002 chain, **module-local**), `exit-finalize.ts:91`, `launch-failure.ts:68` | launch / exit / placement; `sessions.stats` has **7 write sites and 2 `updateSessionStats` definitions** (§ 6 F18) | D11, D6 attestation | hot-on-seam 0.731; knowledge-transfer 0.483 | L |
| Workspace panel | `WorkspacePanel.tsx` (composes 9 hooks; four `useEffect` fetch ladders `:232,:291,:309,:322`; **quiet since July**), `WorkspaceCard.tsx`, `ContextWindowView.tsx:71`, `lib/context-window.ts:97` | issue workspaces + occupancy | D11 fallback, D8b badge | hot-on-seam 0.869; `fetch-in-effect` 5 | M |
| Board route, Layout, cards | `routes/BoardPage.tsx` (no props; 20+ hooks; the 3-way split is an artefact — `requestidlecallback` is a 7-line effect), `Layout.tsx`, `IssueCard.tsx` / `IssueDetailPanel.tsx` | — | none (BoardPage, Layout) · D8b badge (cards, inherited) | **hot-off-seam → watch list** (BoardPage, Layout) | — |

## 4. Do-not-touch (hot, off every row)

The watch list under § 1 is this plan's do-not-touch list; the general-mode rule is that a red
number with no recorded cost is reported, not scheduled. Two entries the seam agents moved *onto*
it after reading: `routes/BoardPage.tsx` (the hottest file has a computed split and no recorded
item — its real decomposition already happened by hooks) and `Layout.tsx` (every hunk since July
is a feature absorbed into one component body, and nothing recorded lands there). And two the
agents moved *off* it into the plan: `session-manager/broadcast.ts` + `exit-finalize.ts`
(D11's "may recur" is live, § 6 F18) and `max-file-size.test.ts` (a second baseline copy, D5).

Explicitly **not built** anywhere in this plan, each with the evidence: a domain-event bus or
outbox beside `board-events` (no in-process subscriber model exists — F8 — so the four
`introduce_event` prescriptions would create a second event system with no consumer); splitting
`shared` (D9, 2.3 % upper bound); breaking the `shared/schema` cycle (it is Drizzle
`relations()`, and removing it costs `db.query.*`); the engine's 4-way `issue.service.ts` split;
a provider base class (decision 007 + the parity test in `types.ts:8-13`); merge-queue batching
(proposal § 5); D4 (producer side — `BACKLOG_FLOOR`, refill loops: policy flips with no code on any
row); D7's miss-rate *measurement* (a corpus that accrues one row a day cannot be refactored into
existence; P1.10/P2.3 feed it, the reading is the team's); #1004's start-mode message (UI text on no
row); the `server ↔ shared` `introduce_facade` (three facades already exist —
`shared/src/index.ts`, `lib/index.ts`, and the mandated deep-path convention; the leakage is the
DTO ↔ route pairing a facade cannot remove).

## 5. Phases

Each item names its source, the number it moves, and the recorded item it makes cheaper. Sizes are
S (an afternoon) / M (a day or two) / L (a week). Every criterion records its phase-start value
and what would turn it red; § 7 lists the ones a reviewer judged unable to fail and what replaced
them.

### Phase 0 — Baseline & safety net *(behaviour-preserving)*

**Goal.** Pin every number a later criterion moves, make the plan's targets *declared* instead
of defaulted, and put characterisation tests where Phases 1–3 will cut.

- **P0.1** `code-metrics baseline` at the phase-start sha; declare in `.codemetricsrc [scorecard.targets]` the **three** scorecard rows this plan cites — logic in adapters (35 %), entanglement (0.267), duplicated code (14 %) — **at their current values** [src: scorecard.txt]. Not tighter: a target above today's value is a gate that is red on arrival (decision 016's reasoning). "Files with complex functions" (435) was in the draft and struck in round 1 (finding 4): P3.2's split moves CC > 10 functions into more files and would turn that row red by the plan's own surgery, and § 6 F17 showed the count inflated on `.tsx`. (S)
- **P0.2** Declare `issues` as an owner subtree in `repository-table-ownership.test.ts:51` with the § 6 F11 writer list as its grandfathered baseline (≥ 21 files, 3 packages), shrink-only — the D10 convention applied to the gap D8a needs closed first. (S)
- **P0.3** Characterisation tests at the cut lines: the red-debt subset rule (`workspace-merge-gate.ts:478-540`) on the `redBasePolicy` dimension (the level dimension is already pinned by `merge-gate-red-debt-subset-rule.test.ts:117-173`); the related-issues / touched-files routes (`routes/issues.ts:355-420`). The draft had exit-handler suites for `handleReviewSessionExit` / `handleBuilderSessionExit`; round 1 struck them (no phase cut those handlers, A6) and added P1.12, which edits every broadcast line in them — so round 2 put **one narrow suite back**: per exit route, the ordered board-event sequence as a table test, with the negative control "swap two kinds". The ten existing suites that assert broadcasts on exit paths (`exit-workflow-idle-terminal-race`, `stranded-fix-and-merge-resolver-exit`, `session-completion-callback-idempotency`, …) are the partial net it completes. The repo's own convention (`nowOverride`, pathspec commits) applies. (S)
- **P0.4** Correct the two stale sentences this run found: `docs/package-boundaries.md` "`openapi.yaml` has not been regenerated since the commit that created it" (regenerated `b10406295e`, 2026-09-01, and gated by `openapi-drift.test.ts` — F14); `CONTINUE.md`'s "1014 lines" for `test-impact-outcome.service.ts` (928 — F2). (S)

| # | Exit criterion | Phase-start | What turns it red |
|---|---|---|---|
| E0.1 | `code-metrics scorecard <A>` prints `3 targets declared`, and each declared value **equals the pinned baseline reading** for that metric (35 % / 0.267 / 14 %) — a diff of `.codemetricsrc [scorecard.targets]` against `baseline`'s values is empty | 0 declared | a target declared at a value other than the pinned one (hand-"improved", or copied from the defaults); fewer than three declared. The 6b-0 pass struck the draft's "all four read ✅" clause as green by construction (A5) |
| E0.2 | `repository-table-ownership.test.ts` has an `issues` owner with a baseline equal to the F11 list; the suite is green; adding one `db.update(issues)` outside the owner subtree in a scratch branch turns it red (run once to prove) | no `issues` owner | the negative control not failing — i.e. the baseline was set wide enough to hide a new writer |
| E0.3 | the red-debt rule has tests on the **`redBasePolicy` dimension** (today `merge-gate-red-debt-subset-rule.test.ts:117-173` pins the *level* dimension and mentions the policy once — that half is already true and is not the criterion); the touched-files suite and the exit-route event-sequence suite exist; each new suite has been shown to fail against a one-line behaviour change (negative control run, not promised) | policy dimension: 0 tests; level dimension: pinned; routes: 15 hits in `issues-routes-edge-cases.test.ts` | a suite that passes with the behaviour flipped; the policy tests asserting on the level |

**Risks.** P0.2's baseline is the enumeration in F11; a spelling not tried (`writeDb.update`, a
transaction alias) would leave a writer un-owned — the negative control in E0.2 is the check.
**Do-not-build in Phase 0.** Any target tighter than today; any refactor.

### Phase 1 — Quick wins on the seams — **FIRST DEVELOPER-VISIBLE OUTCOME**

**Goal.** Twelve afternoon-sized items, each on a hot-on-seam file, each moving a ratcheted
number and making a recorded item cheaper. The developer-visible outcome is **P1.9** (the D11
defect class — two write paths onto `sessions.stats` — closed at its root: definitions 2 → 1,
writes outside the chain 5 → 0) **with P1.2** (207 → 197, 58 → 56). Both are counts a ratchet
reads and both close a recorded item. The D2 slice (P1.3, P1.3b, P1.10) is the phase's second
outcome, and it was wrong twice before it was right: the first draft's marker was a phantom
(§ 7, skeleton pass), and the second draft's "`redBasePolicy` stops being dead" could not happen
because the policy is a pure function of the level (§ 7, round 1, finding 1) — P1.3b is the
override that makes D2 reachable at all.

- **P1.1** — **struck in round 1** (§ 7, finding 2). The draft moved the gate ↔ runner env names and the two `ALWAYS_RUN_*` regexes into `shared/lib`; the file it would have edited records why the duplication is deliberate: `scripts/test-mine.mjs:286-295` — the runner is bare `node` with no build step and worktrees have no `shared/dist`; `packages/server` ships only `dist/`, so `tier.ts` cannot import a repo-root script either; the two copies are held to the same *rule* by `always-run-dirs-lockstep.test.ts` with fixtures. The draft's "the script already imports from `shared`" was false (its only local import is `./machine-verify-lock.mjs`). The 10 env names stay a tested mirror; § 6 F4 stands as a description, not a work item.
- **P1.2** [S1] Outbound schemas for the 10 `/api/issues/*` entries in `UNVALIDATED_API_RESPONSES:69-78`; zod bodies for the two remaining raw reads in `routes/issues.ts:148` (bulk PATCH) and `:792` (time-entries). [src: seam 1 §Q1b]. Cheaper: D9, D8a. (S)
- **P1.3** [S2] `workspace-merge-gate.ts:478-540` keys the red-debt subset rule on `posture.redBasePolicy` instead of `posture.level === "fast" | "sprint"` (`:510` is the single place the level is consulted for the rule). Two traps: the skeleton review found the cap-degrade at `:498-507` degrades the *level*; round 2 found the gate does not use the server's posture resolver at all — `:59` imports the **shared, level-only** `resolveRiskPosture(value)` (`shared/lib/risk-posture.ts:52`) and reads the raw pref at `:485-486`, so the first bullet of this item is *replace that raw-pref + level read with the service resolver* (`risk-posture.service.ts:64`, prefMap from `getPreferences`) — the function P1.3b extends. The two same-named functions are not one (§ 6 F21 counted the level literal on the wrong path). The existing `risk-posture.service.test.ts` pattern covers it. [src: § 6 F1]. Cheaper: D2, **only together with P1.3b** — on its own this is a rename: at `iterate` the derived policy is `block`. (S)
- **P1.3b** [S2] **The override that makes D2 reachable.** `redBasePolicy` is derived from the level in `resolveRiskPosture` (`risk-posture.service.ts:89,106,123,145,166`: `strict`/`standard`/`iterate` → `block`, `fast` → `allow-known-debt`, `sprint` → `allow-file-debt-ticket`), and the proposal wants `iterate` kept *and* `allow-file-debt-ticket` on — unreachable without a per-field override. Item: a per-project `red_base_policy_<projectId>` preference consumed in `resolveRiskPosture` after the level switch, plus a one-paragraph amendment to decision 017 saying which direction an override may move a project (the plan proposes: **only towards the proposal's land-then-heal**, i.e. an override may soften the red-base policy and nothing else; a "stricter" override is a level change; **the cap wins** — an over-cap ledger forces `redBasePolicy` back to `block` regardless of override, because the #916 degrade operates on the level and an overridden `iterate` project has no level to degrade; and the per-ticket `risk:*` tag override outranks the project policy override, as it outranks the level today). The override must surface in `RiskPosture.source` / `summary` (`shared/types/api/monitor.ts:60`, `risk-posture.service.ts:34`) or the posture "weakens invisibly" — the failure 017 forbids — and `risk-posture-raw-read-ratchet.test.ts` extends its scan to the `red_base_policy_` literal (today `risk_posture_` only). Cheaper: D2. (S)
- **P1.4** [S2] **WIP consumes the capacity snapshot that already exists.** The skeleton review refuted the draft's version of this item: `machine-capacity.ts:103-124` already parses `fleet snapshot`'s `verdict.canStartAnother` into `hold`, `isHostSaturated` (`monitor-auto-start.ts:427-429`) already returns it, and `decideGateQuiesce` (`gate-quiesce.ts:81-90`) already reads `hostHeld` — "0 → 1 readers of `fleet gate`" would have moved only because nobody had typed the word. D3's real gap is that the **WIP limit** never sees the snapshot: `resolveWipLimit` (`wip-limit.service.ts:85-110`, the actual single WIP reader — § 6 F9) and the `resolveMonitorTunables` consumers (`routes/board-monitor.ts`, `auth-rotation-ring.ts`, `dependency-wave.repository.ts`) resolve targets from prefs alone. Item — placed by the second skeleton pass, not the first: `resolveWipLimit` is itself a pure prefMap resolver by charter (`wip-limit.service.ts:22-24`) and four of its five callers have no snapshot, so the clamp goes where the snapshot lives — the monitor cycle's `wipLimitFor` (`monitor-auto-start.ts:946-950`), as an **optional** `{ capacity, running }` opt on `resolveWipLimit` applied only when supplied, and applied **after** the `hasFleetOverflow` check (`:434`) so #908's "placement, not a gate" rule keeps working. The three `resolveMonitorTunables` display consumers (`routes/board-monitor.ts` …) show `source: "capacity_hold"` when the clamp is in force. **And** the two other start paths — `plugin-loop-start.service.ts:67` and `dependency-auto-chain.service.ts:195` — *already* resolve WIP through `resolveWipLimit` (via `resolveStartPolicy`, `start-policy.service.ts:69-70`; round 2 corrected round 1's "three bypassing readers": only `sprint-capacity.service.ts:93` bypasses it, and its sole consumer is the analytics route, a display). What they lack is a **capacity snapshot**: `readMachineCapacity()` has one caller (`monitor-auto-start.ts:957`). Item: `resolveStartPolicy` gains the same optional opt, and the two starters receive a snapshot — the cycle's cached one passed down where they run inside it, else a `fleet` spawn per call with the existing 5 s timeout (`machine-capacity.ts:101`). Kill-switch, already there: `SMART_HOOKS_FORCE=1` forces `hold: false` (`machine-capacity.ts:64`); the `configured` value stays untouched (drive-preflight reads it). `resolveMonitorTunables` stays pure (decision 006). Cheaper: D3. (S)
- **P1.5** [S1] Extract `routes/issues.ts:355-420` (related-issues / touched-files, 3 functions) as its own router file; facade re-export; a `split-responsibility-ratchet` entry. Cheaper: D8a, the #831 remainder. (S)
- **P1.6** [S2] One baseline for the god-module ceiling: `shared/__tests__/max-file-size.test.ts` imports `scripts/check-god-modules.mjs`'s baseline instead of carrying a copy plus a parity test (`:460`). Cheaper: D5. (S)
- **P1.7** [S3] `useAgentSettingsData(activeProjectId)` — the four profile lists, `profileHealth`, the preflight (`SettingsPanel.tsx:225`) and the divergence check — moves out of `SettingsPanel` into `settings/AgentSettings.tsx`, which owns the roster later. [src: seam 3 §6]. Cheaper: D6. (S)
- **P1.8** [S3] `useIssueWorkspaces(issueId)` on `hooks/useApiResource.ts` (#513's named replacement) replaces WorkspacePanel's four `useEffect` fetch ladders (`:232, :291, :309, :322`); in the same pass, `lib/context-window.ts:97`'s secondary fallback (`inputTokens + cacheReadTokens`, cumulative for claude result stats — D11) stops rendering a session total as occupancy. Cheaper: D11, D8b. (S)
- **P1.9** [S3] Two things, kept apart (round 1, finding 7): (a) delete the unsanitised `updateSessionStats` at `repositories/session/stats.ts:70` and point `cli/commands/session.ts:170` at the sanitised `broadcast.repository.ts:24`; (b) the **stop-write stays one UPDATE** — `updateSessionStoppedWithStats` (`session-lifecycle.repository.ts:143-153`) sets `status`, `endedAt`, `exitCode` and `stats` atomically, and its four callers (`exit-finalize.ts:91`, `launch-failure.ts:68`, `devcontainer-launch.ts:87`, `session-lifecycle.ts:950`) are *serialised through* the #1002 chain — **read, merge and UPDATE together**: `exit-finalize.ts:90-91` and `session-lifecycle.ts:949-950` do `mergeExistingSessionStats` (a read) *then* the UPDATE, and queuing only the UPDATE leaves the read outside the critical section (round 2, finding 2 — the exact #1002 shape). So `queueStatsWrite` (`broadcast.ts:105`, module-private today) is exported as `withStatsWriteChain(sessionId, fn)` and both merging callers move their read+merge+UPDATE inside it; `launch-failure.ts:68` and `devcontainer-launch.ts:87` write whole blobs at launch and need no chain. Kill-switch: the chain waits on the previous write *settling* and has no timeout — the repo has measured libsql writes hanging past 25 s (`startup-tasks.ts:179`) — so the stop-write gets a bounded wait (10 s) after which it proceeds and logs the stall, or a session could never become `stopped`. `cli/commands/session.ts:170` is a separate process the chain cannot cover; it stays a direct sanitised write and the plan says so. The chain's own writer (`broadcast.ts:69,118`) must import the sanitised definition before `stats.ts:70` is deleted. [src: § 6 F18]. Cheaper: D11. (S)
- **P1.10** [S2] **Heal ticket, log-only.** In the nightly sweep that already runs — `base-branch-health-reconciler` (`background-services.ts:235`) → `base-branch-health.service.ts:417 recordBaseSweepOutcome` — a red sweep, when `redBasePolicy === "allow-file-debt-ticket"`, logs the `heal` ticket it *would* file (title, failing-suite list — `result.failedSuites` is in hand at `:404,:420`, the project at `:418`) without writing one. The policy is **not** in hand there: `resolveRiskPosture` is read one level up in `base-branch-health-reconciler.ts:30`, so P1.10 threads `redBasePolicy` down into `verifyBaseBranchHealth` as a parameter — not a new read. No new service: the skeleton review found the draft's "24th `BACKGROUND_SERVICES` entry" would poll for what the sweep holds in hand, and D8c wants that registry shorter, not longer. Cheaper: D2. (S)
- **P1.11** [S2] **Boot from `dist/`, hermetically.** A smoke test that builds in a **throwaway `git worktree`** — the "temporary out-dir" arm does not exist: `scripts/build-server.mjs:8-12` resolves and wipes `packages/server/dist` unconditionally, `tsconfig.build.json` pins `outDir`, and `copy-assets.mjs` copies the migrations into that same directory (round 2, finding 6) — running `build:shared` + `build:server` + the assets copy only (the client build in `pnpm build` is not under test), pins `KANBAN_DB_URL` and `AGENTIC_KANBAN_DIR` to scratch (otherwise `runMigrations`, `startup-tasks.ts:171-190`, takes a full-size `VACUUM INTO` backup of the *live* `kanban.db` before migrating it — CLAUDE.md's first hard constraint), boots the built entry, waits on the dev-server skill's readiness mechanism (CLAUDE.md forbids polling ports in a loop), and checks that the migrations directory resolved relative to `dist/`, the bundled skills directory is present, and `/health` answers. Round 1 (finding 5) caught the draft's version violating three hard constraints at once. The one code-side question D1 leaves open. Cheaper: D1. (S)
- **P1.12** [S2] **One place to hook a session-exit outcome.** The exit flow's broadcast sites — 17 in `exit-workflow.ts` (§ 6 F6) **plus at least 10 in `startup/exit/*`** (`fix-and-merge-exit.ts` 4, `usage-limit-exit.ts` 3, `review-launch.ts` 2, `clean-clone-checks.ts` 1 by `broadcast(`; round 2, finding 4) — go through one `emitExitOutcome(kind, payload)` helper in `startup/exit/`, where `kind` is an **exit-outcome enum** (`completed | idle | ready_for_merge | merged | fix_and_merge | usage_limit | error | …`) mapped to board-event names inside the helper. That mapping is what makes it more than a rename (round 2, R3): a tracker or PR consumer hangs on the outcome vocabulary, not on the six board-event strings. Not an event bus (F8). The exit-handler characterisation suites struck in round 1 come back narrower (P0.3): per exit route, the ordered board-event sequence as a table test, because E1.12's count cannot see a `kind` mapped to the wrong event. Cheaper: D8a, D8b. (S)

| # | Exit criterion | Phase-start | What turns it red |
|---|---|---|---|
| E1.1 | — struck with P1.1 (round 1). Its third clause was also A1: a 180-day co-change pair cannot move inside a phase without `--history-ref`, and an added import satisfies "has an edge" by construction | — | — |
| E1.2 | `UNVALIDATED_API_RESPONSES` count ≤ **197** and `BASELINE_TOTAL` ≤ **56**, both suites green, and `openapi-drift.test.ts` green | 207 / 58 | a new unvalidated response or body read added in the same phase (the ratchets are down-only, so the count would rise and the suite fail) |
| E1.3 | `workspace-merge-gate.ts` no longer imports the shared level-only resolver (`grep -c "shared/lib/risk-posture" workspace-merge-gate.ts` = 0, from 1); a test at level `iterate` with `red_base_policy_<id> = allow-file-debt-ticket` **softens** the red-debt rule (the ticket lands), the same level without the override **blocks**, the override **with an over-cap ledger blocks**, and the resolved posture's `source`/`summary` name the override; decision 017 carries the amendment; the raw-read ratchet scans `red_base_policy_` | gate on the shared resolver; policy derived only; ratchet scans one key | the override ignored at `iterate`; the cap bypassed under override; a softened posture with a `default` source; an override that also changes the gate tier or review mode |
| E1.4 | `resolveWipLimit`'s signature carries the optional capacity opt (`grep -n "capacity" wip-limit.service.ts` ≥ 2 — one hit today, a comment at `:14`) and `wipLimitFor` passes it; a test with `hold: true`, 3 running, pref 5 resolves 3; with `hold: false` resolves 5; with `hold: true` **and** `hasFleetOverflow` the existing #908 test still passes (the clamp is bypassed); start paths that resolve WIP **without** the capacity opt = **0** (from 3: `wipLimitFor`, `plugin-loop-start` via `resolveStartPolicy`, `dependency-auto-chain` via `resolveStartPolicy`); `sprint-capacity` shows `source: "capacity_hold"` on the analytics route; the body of `resolveMonitorTunables` (`strategy-objective-file.ts:361-388`) contains no `gitExec`/`spawn`/`exec` call (`sed -n 361,388p … \| grep -c "gitExec\|spawn\|exec("` = 0 — the file-level grep the draft named hits an import and comments and is red on arrival) | 0 readers; no clamp; 3 start paths without the opt | the `hold: true` case resolving 5; the #908 overflow test going red; a starter resolving WIP without a snapshot; the resolver body growing a spawn |
| E1.5 | `routes/issues.ts` ≤ **770** lines; the new router is in `split-responsibility-ratchet.test.ts`'s `BASELINE` with its function count; `routes/issues.ts` risk on the next `compare --history-ref <phase-0-sha>` < 0.776 | 827 lines; 0.776 | the extracted file re-growing, or the route count in `issues.ts` unchanged (the extraction was a copy) |
| E1.6 | `max-file-size.test.ts` has no baseline literal of its own (`grep -c "MAX_LINES\|BASELINE" ` shows only the import); the parity test at `:460` is deleted, and — as the negative control for those two, already true today — `pnpm check:arch:serial`'s god-module check still fails on a scratch file of 1,001 lines | 2 copies (`MAX_LINES :66`, `COHESION_BASELINE :87`) + parity test | a copy surviving; the ceiling no longer firing after the import replaced the copy |
| E1.7 | `fetch-in-effect-baseline.ts`: `components/SettingsPanel.tsx` ≤ **1** (from 3), `components/WorkspacePanel.tsx` ≤ **2** (from 5); `AgentSettings` props ≤ **6** (from **17**, counted at `AgentSettings.tsx:55`); a `context-window` test feeds a claude `result` stats blob with cumulative `inputTokens` and asserts the occupancy is **not** the sum | 3 / 5 / 17; fallback cumulative | a ladder moved into the new hook as a raw `useEffect` fetch (the ratchet counts the hook's module too); props pushed back as context; the fallback still summing |
| E1.8 | `grep -rn "function updateSessionStats" packages/server/src` = **1**; the F18 spelling grep — widened with `mergeExistingSessionStats(` (the read half) and `.set({ status: "stopped", endedAt` (the five status-only stop writers in `monitor-cycle.ts:291,756`, `startup-tasks.ts:375` and the reconcilers, allowed as status-only) — lists stats writes only in `broadcast.ts`, `broadcast.repository.ts`, `session-lifecycle.repository.ts:143` and the CLI; a test interleaves a heartbeat **between** the stop-write's read and its UPDATE and keeps every key and the status; a stall test with a never-settling previous write sees the stop-write proceed within the bound | 2 definitions; 7 sites; read outside the chain; no bound | the unsanitised path surviving; the interleaved race losing a key or the status; the stop-write split into two UPDATEs; the stall test hanging |
| E1.10 | with `redBasePolicy = allow-file-debt-ticket` and a red sweep, the sweep's log carries one `heal` line with the failing-suite list and **no** ticket row is written (`issues` count unchanged); with any other policy, no line | no reader of the policy in the sweep | a ticket written in the log-only slice; a line under the other policies; two lines for one sweep |
| E1.11 | the dist-boot smoke test exists, builds in a worktree whose path is asserted not to be the main checkout, pins `KANBAN_DB_URL` to a scratch file (a test assertion, not a convention), and fails when the migrations directory is moved (negative control run once on a copied tree); `/health` answers from the built entry | not tested | the test passing with the migrations dir absent; the test touching the live DB path or the shared `dist/` |
| E1.12 | `grep -rc "broadcast(\|broadcastActivity(" startup/exit-workflow.ts startup/exit/` sums to **1** (the helper's own call), from ≥ 27; a shrink-only ratchet pins sites outside the helper at 0; the per-route event-sequence suite (P0.3) is green and its negative control (two kinds swapped) fails | ≥ 27 sites; no sequence suite | a site outside the helper; the sequence suite passing with two kinds swapped |

**Risks.** P1.3 is a behaviour change *when the policy is flipped* — the characterisation suite
from P0.3 pins today's behaviour for the default. P1.1 moves a constant that 22 lockstep suites
assert on; those suites become redundant, not red. **Do-not-build in Phase 1.** The roster itself
(D6 — Phase 2); the heal ticket *written* (D2 — Phase 2; Phase 1 logs it); any change to the
merge drivers.

### Phase 2 — Contracts and boundaries

**Goal.** Turn the three hand-kept contracts into things the graph can see or a ratchet can
count, and land D2's and D6's first running pieces at the insertion points Phase 1 prepared.

- **P2.1** [S1] The status vocabulary consumed, not just declared: `graphLayout.ts:52 STATUS_ORDER`, `boardActivitySummary.ts:6`, `chartColors.ts:35`, `badgeTones.ts:110` and the mcp tools that hard-code `"Todo"` (`create-issue.ts:68`, `get-board-status.ts:72,236`) key on `CANONICAL_ISSUE_STATUS_NAMES`; a **status-literal ratchet** over the wider scan `status-read-ratchet.test.ts:24-27` already measured (41 files / 87 comparisons), shrink-only. [src: seam 1 §Q1c]. Cheaper: D8a. (M)
- **P2.2** [S1] Shrink the `issues` writer list from the P0.2 baseline. The two startup reconcilers write through `issue-service.repository.ts` (or a second owner subtree if their writes are a different aggregate — § 9). The five mcp-server tools **cannot** import a `server` repository without creating an `mcp-server → server` static edge that does not exist today (`module-graph.txt`: `mcp-server → shared` only; round 1, minor) — their write path moves to `shared/lib` under the existing `shared-db-op` pattern (18 files, `patterns.txt`), and the owner subtree names that module. Cheaper: D8a. (M)
- **P2.3** [S2] The **heal ticket written**: P1.10's log line becomes one ticket per red sweep, inside the sweep (`base-branch-health.service.ts` after `:417`), gated on the policy, with the failing-suite list as body. The write goes through the `issues` owner path (`issue-service.repository.ts`), not `createIssueWithNextNumber` in `cli-commands.repository.ts:163` — otherwise E0.2's ratchet is the first thing it turns red; so P2.2 lands first or is bundled. "Start outside the WIP limit" as the proposal phrases it has **no mechanism today** (`grep skipAutoStart\|exempt\|bypassWip` → 0; `issues.priority` only orders the start score, `monitor-auto-start.ts:795-801`): Phase 2 files the ticket at top priority — *ordering within* WIP — and a hold-exempt flag is deferred to P3.2 with its own criterion. `BACKGROUND_SERVICES` stays at 23. Cheaper: D2. (S)
- **P2.3b** [S2] **Base-advance record, log-only, at the server sites.** Every base-advance site the § 6 F7 grep lists — `merge-executor.service.ts:101`, `merge-train.service.ts:102,183`, `workflow-fork.service.ts:613`, `worker-remote-sync.service.ts:63,102` — logs `(repo, ref, oldSha, newSha, source)`; `shared/lib/git-service/merge.ts` gains an **additive** `mergeBranchWithShas` returning the `(oldSha, newSha)` pair it already holds (`targetSha` at `:224`, `newCommitSha` / `resolved.commitSha` at `:395,:349`) — round 1 (minor) rejected changing `mergeBranch`'s return type across every consumer to spare one regex; the train's re-`rev-parse` at `merge-train.service.ts:181-183` is what the new function replaces. The two `update-ref` sites in `worker-remote-sync.service.ts` already have both shas local and need only the log line. Precision on the count (round 1, minor): `merge-train.service.ts:102` advances the *train ref*, not the base, so the F7 list is **4 base-advance sites + 1 train-ref site**; the record covers all five because the train ref is what lands on the base at `:183`. Moved up from Phase 3 by the skeleton review: P2.4's rule needs the old→new range per advance, and today the predicates only see shas. Cheaper: D2, D8b. (S)
- **P2.4** [S2] The **gate-discard rule** on the predicates the engine already isolated (`monitor-cycle.ts:337-364`) and `merge-gate-evidence.ts:31-33 movedDuringGate`: a base moved only by commits whose files are in neither the branch diff nor its impact selection keeps its verdict — the range comes from P2.3b's record; the selection does **not** come from the gate evidence yet: `impactSelection` is computed in `pre-merge-gate.service.ts:423` and `merge-gate-evidence.ts` carries no selection (0 hits), so the first bullet of this item is *persist `impactSelection` with the gate run* — without it E2.4's out-of-selection case cannot be written. Cheaper: D2 (#979/#986). (M)
- **P2.5** [S3] D6's insertion point made real: the roster is applied at `provider-config-resolution.ts:125-141` (where the allowlist clamps today) as a **refuse-not-clamp** step, ahead of the rotation ring; `SettingDef` gains `section` and a `type: "json"` roster entry so `AgentSettings` renders it from the registry. Proposal § 6 is a *Vorschlag*; this item is preceded by a decision record (018, the roster and its three roles) — round 1 (minor). Round 1 also read `section` as a registry mechanism for one row (R3): it is, and it stays only because the eleventh hand-built tab is the alternative and the registry already exists for the data half. Cheaper: D6. (M)

| # | Exit criterion | Phase-start | What turns it red |
|---|---|---|---|
| E2.1 | the status-literal ratchet exists with baseline **41 files / 87 comparisons** and reads ≤ **30 / 60** at phase end; `status-read-ratchet` ≤ **20** (from 27); client files importing `status-transitions`/`project-statuses`/`status-view` ≥ **10** (from 3) | 41/87 · 27 · 3 | a new literal comparison anywhere (the ratchet is shrink-only); the import count not moving because the tone maps were re-keyed on a local copy |
| E2.2 | `issues` owner baseline ≤ **12** files (from ≥ 21 by F11's wide spellings; **14** by the narrow `\.(update\|insert\|delete)\(issues\)` — the baseline uses the wide list). The plan says separately, not as a criterion, that `--module-crime` will still list `mcp-server ↔ server` as hidden: the REST surface both call is the shared thing | ≥ 21 (wide) / 14 (narrow) | a writer added outside the owner (E0.2's ratchet); mcp tools writing through a copy of the repository instead of the repository |
| E2.3 | with the policy on, a red sweep produces exactly one open `heal` ticket (integration test against the sweep → ledger → ticket chain) and a second red sweep on the same failures produces none; with the policy off, zero; `BACKGROUND_SERVICES` still **23** | 23; log-only | two tickets for one failure set; a ticket under another policy; a 24th service |
| E2.3b | the five F7 sites each emit the advance record; a ratchet greps the advance spellings — `mergeBranch(`, `"update-ref"`, `advanceRefWithCas(`, **and** the ones F7 missed: `branch", "-f"`, `pull", "--ff-only"`, `merge", "--ff-only"` (`branch-attach.ts:22,47`, `merge-train.service.ts:74`, `plugin-lifecycle.service.ts:149`, `worker-remote-sync.service.ts:173`, `worker-repo.ts:339` — none advances a project base today, all are grandfathered as non-advances by name) — against a call to the recorder, baseline 5 of 5; `mergeBranchWithShas` exists and the train uses it | 0 of 5 | a sixth advance site without the record; the pair reconstructed by a second `rev-parse` instead of returned |
| E2.4 | `impactSelection` is persisted with the gate run (`grep -c impactSelection merge-gate-evidence.ts` ≥ 1, from 0) and the discard rule has a test with the three cases (base moved by an in-selection commit → discard; by an out-of-selection commit → keep; by both → discard). The ledger's weekly discard count is **reported** in § 8, not a criterion: it has no phase-start value in this document (6b-0, A2) | 0 hits; no rule | a kept verdict on an in-selection move (the safety case); the rule reading shas instead of P2.3b's range |
| E2.5 | `provider-config-resolution.ts` applies the roster before the ring and refuses (`throw`/`hold`) a `forbidden` profile chosen explicitly at the workspace level, per proposal § 6 — test with the negative control; `AgentSettings` renders the roster from the registry entry — `grep -rl "settings-registry" packages/client/src/components/settings` ≥ **2** (from 1: `AppearanceSettings.tsx`) | 0 roster; 1 registry importer | a `forbidden` profile clamped instead of refused; an eleventh hand-built tab |

**Risks.** P2.2 may find that the startup reconcilers write `issues` for a different aggregate
(dependency edges, backlog snapshots) — then the answer is a second owner, not a forced funnel
(§ 9). P2.4's first bullet (persist the selection) is a schema-adjacent change — a new column or a
JSON field on the gate evidence — and the table-width ratchet applies. **Do-not-build in Phase 2.** A domain
event bus for the heal ticket (the sweep holds the outcome in hand); a 24th background service; a
provider base class; the schema cycle.

### Phase 3 — Structural surgery

**Goal.** The harder-to-change items, each with its measured pain, a rejected cheaper
alternative, and a reversible first slice.

- **P3.1** [S2] **The base-advance funnel, server-side.** Pain: five sites advance a base branch, three outside `runMergeCore` (§ 6 F7), so D8b's merge tail has no single place to hang. Cheaper alternative rejected: routing everything through `runMergeCore` (the train and the fork-join are not merges of one workspace). Rejected by the skeleton review: a hook beside `advanceRefWithCas` in `shared/lib/git-service/merge.ts:75` — it is module-private with two callers, and a ledger hook there drags the DB into the pure git adapter (and trips the single-consumer ratchet). Shape: P2.3b's log-only record becomes a server service `base-advance.service.ts` the five sites call, which the merge tail (`merge-workflow.ts:452-619`, `merge-cleanup.service.ts:243-303`, `workspace-merge-cleanup.service.ts:85-146`) subscribes to in the PR/CI plan's Phase 1 — this plan stops at the funnel. (M)
- **P3.2** [S2] **`monitor-cycle.ts` and `monitor-auto-start.ts` cut by their real seams**, not the engine's clusters: the per-state handlers (`monitor-cycle.ts:444-790`) and the base-moved predicates out of `monitor-cycle`; `runInProgressBackfill`, `runTodoPull`, `buildDependencyGate` out of `monitor-auto-start`. Pain: 0.765 / 0.770 risk, both at the 1000-line ceiling, both on D2/D3. Cheaper alternative rejected: the computed 4/6-way split (four of the groups are interface fields and a 15-line adapter — seam 2 §4). One file per commit, facade re-exports, ratchet entries. (L)
- **P3.3** [S1] **One DB-handle factory**: `shared/lib/db-client.ts` (`createClientWithPragmas:92`) constructs every handle; `server/db/index.ts:28,43`, `db/backup.ts:137,196,368`, `mcp-server/db.ts:42` call it. Pain: 7 `createClient(` sites in 4 files, one pragma policy; D8c and D1 both need one port. Cheaper alternative rejected: leaving backup's ad-hoc clients (they are the ones that open the file a second time). (M)
- **P3.4** [S3] **Placement out of `session-lifecycle.ts`**: the `worker-fleet` interaction (placement / attestation) becomes its own module, so D6's attestation has one file and the fifth "back under 1000" refactor is the last. (M)

| # | Exit criterion | Phase-start | What turns it red |
|---|---|---|---|
| E3.1 | every site the F7 grep lists calls `base-advance.service`'s recorder (E2.3b's ratchet, now 5 of 5 through one module instead of five log lines); `shared/lib/git-service/merge.ts` imports nothing from `server` or the DB (`grep -c "from .*\(server\|db\|repositor\)" merge.ts` = 0 — the bare word hits two comments today) | 5 log lines | a sixth advance site; a DB or server import in the git adapter |
| E3.2 | `monitor-cycle.ts` and `monitor-auto-start.ts` both leave `query <A> --class refactor_first --top 40` on `compare --history-ref <phase-2-sha>`; summed `max_cyclomatic` over each file's extracted set within ±10 % of the original (a line move, not a rewrite); every extracted file in the split ratchet | 0.765 #16, 0.770 #14 | a file back in the top 40; summed CC dropping > 10 % (behaviour was changed, not moved) or rising |
| E3.3 | `grep -rEn "createClient\(" packages/*/src --include=*.ts \| grep -v "__tests__\|\.test\.\|^\S*:\s*\*\|//"` ≤ **1** (the factory at `shared/lib/db-client.ts:92`; the two comment hits in `pragmas.ts:6` and `db-client.ts:12` are filtered); `mcp-server/db.ts` and `db/backup.ts` import the factory | 7 sites + factory | a new direct `createClient(`; the factory bypassed by `backup.ts` |
| E3.4 | `session-lifecycle.ts` ≤ **800** lines and off the `refactor_first` top 40 on the phase-3 compare; `session-manager/session-placement.ts` (which already imports `worker-fleet.service.ts` — it is the module to extend, not a new one) is the **only** importer of it under `session-manager/` (`grep -rln worker-fleet.service packages/server/src/services/session-manager` = 1, from 2) | 988 lines, 0.731 #23; 2 importers | placement re-imported from lifecycle; the file re-growing past 900 |

**Risks.** P3.1 stops at the funnel on purpose; the merge tail as a subscriber belongs to the
PR/CI plan and is not in this document. P3.2 is the largest item and
sits after Phase 2 deliberately — D2's rule and D3's read land first in the files as they are,
so the surgery happens on files whose new behaviour is already pinned. **Do-not-build in
Phase 3.** The engine's name-cluster splits; the schema cycle; an event bus.

### Phase 4 — Ratchet & harden

- **P4.1** Re-read the watch list (§ 1) against the Phase-3 snapshot; each entry is either promoted with a recorded item or kept with a fresh number.
- **P4.2** Delete every grandfathered entry that reached zero (issues owner, status literals, fetch-in-effect for the two files); re-declare the three scorecard targets at the Phase-3 values (an item — E4.1 measures the arc against the Phase-0 pin, not against this re-declaration).
- **P4.3** D5's audit as a standing rule: each of the 168 always-run suites and 38 ratchets carries a one-line "property it pins" and a last-red date, generated from git; suites with no red since introduction are candidates to merge or drop — the decision is the team's (§ 9).

| # | Exit criterion | Phase-start | What turns it red |
|---|---|---|---|
| E4.1 | on the Phase-4 `compare --history-ref <phase-0-sha>`, each of the three declared metrics reads **at or better than its Phase-0 declared value** (logic in adapters ≤ 35 %, entanglement ≤ 0.267, duplication ≤ 14 %) — the plan's whole arc, measured once against the pin; **plus** `worst function complexity` (76 today, a per-function measure a split cannot punish) ≤ 76 | 35 % / 0.267 / 14 % / 76 | any of the four above its Phase-0 value (a regression the quick wins did not pay for). The draft's "declared at Phase-3 values and ✅" was struck as green by baselining (6b-0, A5) |
| E4.2 | the guard inventory exists as a generated table (`scripts/`, from `git log`) **and marks at least one suite `merge` or `drop`** (an inventory that marks nothing is report-only and this criterion is then recorded as not met); every suite it marks `drop` is absent from the tree by phase end, and every suite it marks `merge` has its negative control still failing after the merge | no inventory | a `drop`-marked suite still present; a merged suite whose negative control passes. The draft's "*or* the team recorded the decision" arm was struck (6b-0, A9) |

## 6. Verification of the load-bearing claims

Twenty facts of the five kinds were attacked with the fixed method (enumerate the target in every
spelling; re-derive counts by a second shape; search for the shape of an abstraction, not its
name; re-derive second-hand numbers; quote the endorsing sentence). Checks are recorded **as
performed**.

| # | Claim | Kind | Check as performed | Verdict |
|---|---|---|---|---|
| F1 | `redBasePolicy` (decision 017) has no reader — D2's "config flip" is new code | absence | `grep -rln "redBasePolicy\|allow-file-debt-ticket\|red_base_policy" packages/*/src scripts` → `risk-posture.service.ts` (emitter), its test, `shared/types/api/monitor.ts` (type). No consumer. | **confirmed** |
| F2 | `test-impact-outcome.service.ts` is 1,014 lines (CONTINUE 2026-09-02) | second-hand | `wc -l` → **928**; `row-quality.ts` was split out in `9bde4f639a` (2026-09-02) | **refuted** — 928, ceiling 1000 |
| F3 | `BACKGROUND_SERVICES` has 23 entries | count | `grep -c 'name: "'` → 23; `{ name:` lines → 23 | confirmed |
| F4 | gate ↔ test-mine contract is env names + 2 regexes duplicated by hand | contract | `sed -n 243,249p pre-merge-gate-tier.ts` shows both regexes with "Mirrors … held in lockstep"; `grep -n ALWAYS_RUN scripts/test-mine.mjs` → `:281`, `:304` identical; env literals on both sides (`grep -oh "KANBAN_[A-Z_]*"`, `comm -12`) → **10** shared names (agent said 13; the extra three are not literal on the gate side); no `gate-env` module in `shared/lib` (`ls` → `gate-activity.ts`, `verify-command.ts` only) | confirmed (13 → 10) |
| F5 | 24 test files import `test-mine.mjs` | count | `grep -rl "test-mine.mjs" packages --include=*.test.ts` → **22** | weakened (22); no criterion rests on it |
| F6 | `exit-workflow.ts` has 17 broadcast sites | count | `grep -c "boardEvents.broadcast\|\.broadcast("` → 17; matches the 2026-09-01 plan independently | confirmed |
| F7 | "every base-branch advance goes through `runMergeCore`" | exclusivity | target grepped as `mergeBranch(`, `"update-ref"`, `advanceRefWithCas(` over server + shared src, tests excluded → `merge-executor.service.ts:101` (runMergeCore), `merge-train.service.ts:102,183`, `workflow-fork.service.ts:613`, `worker-remote-sync.service.ts:63,102` (+`:226` delete), `shared/lib/git-service/merge.ts:351,400` (the one primitive) | **refuted** — 3 advance sites outside `runMergeCore`; the single primitive is `advanceRefWithCas` |
| F8 | no domain-event / outbox shape exists; `board-events` has 3 in-process subscribers | absence | `grep -rln "outbox\|domain_event\|domainEvent\|EventEmitter\|eventBus"` server + shared src → 0; `grep -rn addInvalidationListener(` → `routes/projects.ts:236`, `core-services-wiring.ts:41`, `monitor-setup.ts:692` | confirmed |
| F9 | "`resolveMonitorTunables` is the single Bullseye reader for WIP" | exclusivity | `grep -rln "readStrategyBullseye("` server src → `launch-config.ts`, `start-score-preview.service.ts`, `strategy-objective.service.ts`, `wip-limit.service.ts`, `monitor-start-scoring.ts` — 5 direct readers; the agent found `start-policy.service.ts:70` overriding `activeAgentsTarget` with `resolveWipLimit` | **refuted** — and round 1 refuted the replacement too: `resolveWipLimit` is bypassed by `plugin-loop-start.service.ts:67`, `sprint-capacity.service.ts:93`, `dependency-auto-chain.service.ts:195` (verified by `grep -rn activeAgentsTarget` server src, tests excluded); P1.4 routes those three through it |
| F10 | gate verdict tokens are minted outside `runPreMergeGate` | exclusivity | `grep -rn gateAlreadyPassed` server src (tests, imports excluded) → definition `merge-gate-token.ts:86`; mints at `workspace-merge-gate.ts:258,533`, `monitor-cycle.ts:125`, `merge-gate-evidence.ts:172` | confirmed — 4 mint sites, 1 fresh-run entry point (11 callers enumerated by the agent) |
| F11 | "`issue.service.ts` is the only writer of `issues`" | exclusivity | `grep -rEn "(db\|tx\|database\|writeDb)\.(update\|insert\|delete)\(\s*(schema\.)?issues\b"` server + mcp-server + shared src, tests excluded → **23 files**; raw SQL `UPDATE\|INSERT INTO\|DELETE FROM issues` → 0; `issue.service.ts` → 0 direct writes (it goes through `issue-service.repository.ts`). The agent's enumeration (28 sites / 21 files, 3 packages) is in § 3 S1's note and the scratch report | **refuted** — ≥ 21 writer files |
| F12 | "`server/db/index.ts` is the only DB-handle constructor" | exclusivity | `createClient(\|drizzle(` over src, tests and comments excluded → `db/index.ts:28,43,51,52`, `db/backup.ts:137,196,368`, `mcp-server/db.ts:42,50`, `shared/lib/db-client.ts:92` — 7 `createClient(` sites, 4 files | **refuted** |
| F13 | outbound registry 52 / baseline 207; inbound `BASELINE_TOTAL` 58; `NO_PROPERTY_LIST` 24 | counts (criteria) | `grep -c "{ method:"` in the `API_RESPONSE_SCHEMAS` block → **52**; baseline `grep -cE '^\s*"(GET\|POST\|PATCH\|PUT\|DELETE) '` → **207**; `route-body-validation-ratchet.test.ts:396` `BASELINE_TOTAL = 58`; the 24 is the agent's count, list present at `:68` | confirmed (52, 207, 58); 24 unverified by me |
| F14 | "`openapi.yaml` has not been regenerated since the commit that created it" (`docs/package-boundaries.md`) | doc claim | `git log -1 -- packages/server/openapi.yaml` → **`b10406295e` 2026-09-01**; `openapi-drift.test.ts` gates it | **refuted (stale)** — true when written, false today; P0.4 corrects the sentence |
| F15 | `issues` has no declared repository owner | absence | `repository-table-ownership.test.ts:51-52` → `projects`, `sessions` only | confirmed |
| F16 | only 3 client files consume the shared status modules | count | `grep -rl CANONICAL_ISSUE_STATUS_NAMES\|DEFAULT_PROJECT_STATUSES` client src → 0 by const name; by module path (`status-view\|status-transitions\|project-statuses`) → 3 | confirmed (3 via modules) |
| F17 | function-level CC 30 / 24 / 34 for `fetchWorkspaces`, `loadDeferred`, `handleAddRepoSubmit` | count / engine | branch keywords over the real spans (`sed -n 260,289p` etc.) → **4 / 12 / 10**; the snapshot records `nloc` **198 / 239 / 309** for functions that are 30 / 24 / 27 lines (`analysis.json → files[].functions[]`) — the TSX arrow-function span runs past the function and swallows the following effects and JSX | **refuted** — file-level risk stands, the function rows on `.tsx` do not; an engine defect, filed in the skill repo |
| F18 | "`sessions.stats` is written by one path" (D11) | exclusivity | `grep -rEn "updateSessionStats\(\|\.set\(\{\s*stats\|mergeSessionStats\(\|updateSessionStoppedWithStats\("` server src (tests excluded) → `cli/commands/session.ts:170`; `broadcast.ts:69,118` (the #1002 chain); `devcontainer-launch.ts:87`; `exit-finalize.ts:91`; `launch-failure.ts:68`; `session-lifecycle.ts:950`; two definitions `broadcast.repository.ts:24` (sanitised) and `session/stats.ts:70` (unsanitised) | **refuted** — 7 write sites, 2 definitions |
| F19 | the snapshot describes HEAD | second-hand | `git log --oneline a1714e1fa5..HEAD` → `02102afd6c`, `5b0e96a0c3`, both `docs:`; `docs/**` excluded by `.codemetricsrc` | confirmed |
| F21 | "`workspace-merge-gate.ts:510` is the single place the level is consulted for the red-debt rule" (P1.3) | exclusivity | `grep -n 'level === "fast"\|posture === "fast"\|posture.level'` over the file → **one** hit, `:510` — but round 2 found the level there comes from the **shared** level-only `resolveRiskPosture` (`:59` import, `:486` call on the raw pref), not the server service; the count was right on the wrong path | confirmed for the literal, **weakened** as a statement about the resolver — P1.3's first bullet fixes the path |
| F20 | "WorkspacePanel is the only consumer of `occupancyFromStatsJson`" (D11 phrasing) | exclusivity | agent: defined `lib/context-window.ts:88`, sole consumer `ContextWindowView.tsx:71` (via `WorkspaceCard.tsx`); WorkspacePanel does not import it | refuted (wrong file) — agent's grep, not re-run; nothing rests on it |

The draft was grepped for its own exclusivity language
(`the (one|single|only|sole)|only place|single (writer|source|entry|gate|path|owner|authority)|exactly one|no other`)
after each re-cut; every hit is one of F7, F9, F10, F11, F12, F18 above or the deliberate
"the one real slice" / "the one primitive" phrasings, which name F7's and seam 1's enumerations.

**Unverified, with the reason:** the 12-step provider precedence chain (seam 3 §1) — read, not
re-enumerated; nothing in Phase 1–2 depends on its exact length, and P2.5's criterion tests the
one position that matters (the clamp). The 41-file / 87-comparison status-literal scan — taken
from `status-read-ratchet.test.ts:24-27`'s own header; E2.1's ratchet re-measures it at phase
start. The 12 `KANBAN_*` env reads the agent counted beyond the 10 literal ones. The "61 %
harness" share (second-hand from the proposal; re-derived as 49 % by a subject grep — neither
carries a criterion).

## 7. Adversarial review (step 6b)

Two skeleton passes before the prose (§ Provenance), one exit-criteria pass (6b-0), then the
rubric rounds below. `N = 1` (generalist; the machine could not carry a second reviewer at any
point in the run). Every major finding was verified by grep before its fate was decided.

**Round 1** — generalist, 189,385 tokens, 8.5 min. Verdicts: R1 WEAK · R2 **FAIL** · R2b WEAK ·
R3 WEAK · R4 **FAIL** · R5 WEAK · R6 WEAK · R7 WEAK.

| # | Major finding | Raised by | Fate | Where in the plan / reason |
|---|---|---|---|---|
| 1 | The marker was false: `redBasePolicy` is a pure function of the level (`risk-posture.service.ts:89-166`), so P1.3 alone renames `fast \|\| sprint` to `policy !== block` with no observable effect, and the proposal's "keep `iterate`, switch the ticket policy on" is unreachable | G | **integrated** | P1.3b (per-project override + decision-017 amendment); E1.3 rewritten around the override; marker moved to P1.9 + P1.2; § 8 records the decision the team owes |
| 2 | P1.1 contradicted the constraint recorded in the file it edits (`test-mine.mjs:286-295`: bare-node runner, no `shared/dist` in worktrees, `server` ships only `dist/`); "the script already imports from `shared`" was false | G | **integrated** | P1.1 and E1.1 struck; the mirror stays a tested mirror; § 6 F4 stands as description |
| 3 | `resolveWipLimit` is bypassed by three start paths (`plugin-loop-start.service.ts:67`, `sprint-capacity.service.ts:93`, `dependency-auto-chain.service.ts:195`), so the clamp misses D4's refill loops; § 6 F9 carried an unverified replacement | G | **integrated** | P1.4 routes the three through the resolver; E1.4 adds "bypassing readers 3 → 0"; F9 corrected |
| 4 | E4.1 contradicted E3.2 (A10): the surgery moves CC > 10 functions into more files and raises "files with complex functions"; F17 had shown that count inflated on TSX | G | **integrated** | that row struck from P0.1 / E0.1 / E4.1 (three declared targets); `worst function complexity` (76) added to E4.1 as the per-function measure a split cannot punish |
| 5 | P1.11 broke three hard constraints: built into the shared checkout's `dist/`, ran `runMigrations` (with its `VACUUM INTO` of the live DB) against the resolved DB, and polled a port | G | **integrated** | P1.11 rewritten hermetic (scratch out-dir, `KANBAN_DB_URL` pinned, the dev-server readiness mechanism); E1.11 asserts the pin |
| 6 | Row R5 (`exit-workflow.ts` 0.872) had no item, and P0.3's exit-handler suites protected a cut no phase makes (A6); `project.service.ts` (0.752) had no verdict anywhere | G | **integrated** | P1.12 (`emitExitOutcome`, 17 → 1) + E1.12; the suites struck from P0.3; `project.service.ts` on the watch list with its reason |
| 7 | P1.9 conflated the duplicate definition with the atomic stop-write: `updateSessionStoppedWithStats` sets status + stats in one UPDATE, and routing its callers to a stats-only writer would split or lose the status | G | **integrated** | P1.9 split into (a) delete the unsanitised definition and (b) serialise the stop-write through the chain while keeping one UPDATE; E1.8 names the repository as an allowed site |

Minor findings integrated silently: the F7 spelling inventory widened for E2.3b's ratchet
(`branch -f`, `pull/merge --ff-only`); `merge-train.service.ts:102` counted as a train-ref advance
(4 + 1); P2.3b made additive (`mergeBranchWithShas`); P2.2's mcp writers moved to `shared/lib`
rather than importing a `server` repository (a static edge that does not exist today); P2.5
preceded by decision 018; E4.2 requires at least one `merge`/`drop` mark. Not integrated: "the
honest first outcome is P1.9 alone" — P1.2 stays beside it because both counts are ratchets and
both close recorded items; "move P0.4 to § 8" — the two stale sentences are edits to files in the
repo and stay items.

Exit criteria round 1 judged unable to fail beyond the 6b-0 pass: E1.1 clause 3 (A1 — struck with
P1.1); E1.3's second half (A3/A10 at `iterate` — replaced by the override test); E3.1's
negative-control clause (A3, kept as the control it is, not as the criterion); E4.1 (A10 — the
struck row); E4.2's vacuous case (fixed by the "≥ 1 mark" clause).

**R8 comparison.** The reviewer's one-phase alternative — P1.9′, P1.2, D2-for-real (override +
P1.3 + P1.10), P1.4′ with the three readers, P0.2 — reaches its outcome on day 2 with P1.9. This
plan's marker phase is Phase 1, and after integration its marker *is* P1.9 + P1.2 with the D2
slice second: the same five items, in the same phase, behind the same Phase-0 pin. The phase
order was **not** re-cut; the marker's content was.

**Round 2** — narrow, 155,280 tokens, 7.5 min, scoped to the re-cut Phase 1 items plus R7.
Verdicts: R1 WEAK · R2 PASS · R2b WEAK · R3 WEAK · R4 PASS · R5 WEAK · R6 PASS · R7 WEAK.

| # | Major finding | Raised by | Fate | Where in the plan / reason |
|---|---|---|---|---|
| 8 | Round 1's finding 3 was integrated on a miscount: `plugin-loop-start` and `dependency-auto-chain` already resolve WIP through `resolveWipLimit` (`start-policy.service.ts:69-70`); only `sprint-capacity` bypasses it, and that feeds a display route. The real gap is that only the monitor cycle holds a capacity snapshot | G | **integrated** | P1.4 rewritten around the snapshot (the opt on `resolveStartPolicy`, a snapshot passed down or spawned); E1.4's clause re-based; the kill-switch `SMART_HOOKS_FORCE=1` named; F9 corrected a second time |
| 9 | P1.9(b) serialised the UPDATE but left the read (`mergeExistingSessionStats`) outside the chain — the #1002 shape survives; and the chain has no timeout, so a hung libsql write could hold a session out of `stopped` forever | G | **integrated** | `withStatsWriteChain` exported, read+merge+UPDATE inside it for the two merging callers, a 10 s bound with a logged stall, the CLI named as out of reach; E1.8's race interleaves between read and write and adds the stall test |
| 10 | P1.3/P1.3b named the wrong `resolveRiskPosture`: the gate imports the shared level-only one (`workspace-merge-gate.ts:59,486`), so a field override in the server service would not reach the rule; and an overridden `iterate` project has no level for the #916 cap to degrade | G | **integrated** | P1.3 gains "replace the raw-pref + shared-level read with the service resolver"; the amendment says the cap wins and the tag override outranks the policy override; visibility via `source`/`summary`; the raw-read ratchet scans the new key; E1.3 rewritten; F21 weakened |
| 11 | P1.12 covered 17 of ≥ 27 exit-flow broadcast sites (`startup/exit/*` carries the rest), and without an outcome vocabulary it was a rename with a count | G | **integrated** | scope widened to `startup/exit/**`; `kind` defined as an exit-outcome enum mapped inside the helper; E1.12 re-based |
| 12 | The round-1 re-cut removed P1.12's safety net: the exit-handler suites were struck in the same fate that scheduled an edit of every broadcast line in them | G | **integrated** | P0.3 gets one narrow per-route event-sequence suite with a swap-two-kinds negative control; E1.12 requires it |
| 13 | P1.11's "temporary out-dir" arm does not exist (`build-server.mjs:8-12` wipes `packages/server/dist`; `copy-assets.mjs` targets it) | G | **integrated** | worktree only, `build:shared` + `build:server` + assets; E1.11 asserts the worktree path |

Minor findings integrated: E1.3's grep clause dropped (A3); the `source`/`summary` visibility rule; the tag-override precedence; `SMART_HOOKS_FORCE`; the chain's own writer import; E1.8's widened spelling list; E1.12's equality pin made shrink-only. Not integrated: none rejected.

**R8 comparison, round 2.** The reviewer's one phase is P1.9 (as re-specified) + P1.2 — the plan's marker exactly; it recommends the D2 slice wait behind the decision-017 amendment, and the plan agrees (§ 8). Phase order unchanged in both rounds.

**Termination.** Both rounds changed content *inside* Phase 1 with the order and the marker phase
untouched; round 2's findings were mechanism corrections (the wrong resolver, the wrong half of a
read-modify-write, an undercounted site list), not one-more-member enumeration failures of the
same mechanism — so by the skill's own table this re-cut is re-checked by the author against R2b
and R7 (done: every rewritten criterion above records its phase-start value and its red condition;
P1.12 has its net back) and **no third round was run**. What that leaves unreviewed is recorded in
§ 8.

R2b at delivery: every remaining criterion records a phase-start value and the work that would
turn it red; the ones the passes struck are listed above and in § Provenance.

## 8. Known shortcomings

- **The plan cannot make the `client ↔ server` hidden dependency disappear**, and does not claim to: the 1,055-change-set pair is the TypeScript-only edge (`import type`) the runtime graph erases, plus the REST surface both ends call. Enforcing the contract (P1.2, P2.1) makes the coupling *visible and counted*; the co-change number will keep reading "hidden" on every snapshot. Whoever reads `module-crime` after this plan needs that sentence. Owner: whoever runs the next `compare`.
- **Function-level cyclomatic figures on `.tsx` are not trustworthy in this snapshot** (F17). Every criterion here uses file-level risk, line counts or ratchets instead. Owner: the code-metrics engine (filed).
- **The weekly gate-discard count has no phase-start value in this document** and is therefore reported, not a criterion (it was E2.4's second half until the 6b-0 pass struck it as A2): read it from the outcome ledger at Phase-2 start — the ledger holds 25 rows today and none from base sweeps — and compare after P2.4 lands.
- **D2 needs a decision the data cannot make**: whether an override may move a project's red-base policy away from its level (P1.3b proposes "softer only"). The plan proposes the decision-017 amendment; the team records it or D2 stays unreachable.
- **Round 2 ran narrow and round 3 did not run.** Round 2 saw only the Phase-1 re-cut plus R7; its six majors were integrated and re-checked by the author, not by a reviewer. Specifically unreviewed: the round-2 versions of P1.3 (the resolver swap at `workspace-merge-gate.ts:485-486`), P1.4 (the snapshot handed to `resolveStartPolicy`), P1.9 (`withStatsWriteChain` with a bounded wait) and P1.12 (the outcome enum). A third narrow round on those four items would have seen them.
- **D5's audit is a decision, not a refactor.** P4.3 produces the inventory; which suites to merge or drop is the team's call and this plan does not pre-empt it.

## 9. Open decisions for the team

1. Does the `issues` table have one owner or two (P2.2)? If the startup reconcilers and backlog snapshots are a different aggregate, declare a second owner subtree rather than funnelling them.
2. Is `forbidden` in the roster global-only or per-project overridable *downward* (proposal § 6 says global forbidden stays forbidden)? P2.5 assumes the proposal's answer.
3. Which four scorecard targets to declare in P0.1 — the plan proposes the four it cites; the team may prefer entanglement dropped (its `modularity_inflated` guard has not been checked on this repo).
4. Whether P1.6's single baseline lives in the script or the test (the script is what CI runs; the test is what an IDE runs) — either, but one.

## 10. How to re-measure

```
A=<out>/analysis.json
code-metrics analyze C:\projects\andrena\agentic-kanban -o <out> --days 180          # per phase
code-metrics baseline $A                                                              # P0.1 pin
code-metrics compare <phase-N-1 analysis.json> $A --history-ref <phase-N-1 sha>      # freeze refactor churn out
code-metrics query $A --class refactor_first --top 40                                # E1.5, E3.2, E3.4
code-metrics query $A --coupling --top 40 ; --module-crime                            # E1.1, E2.2
code-metrics graph $A --deps-of packages/server/src/services/pre-merge-gate-tier.ts  # E1.1
code-metrics scorecard $A                                                             # E0.1, E4.1
code-metrics plan-claims docs/plans/2026-09-03-general-architecture-plan.md --analysis $A
code-metrics plan-decisions docs/plans/2026-09-03-general-architecture-plan.md
```
Plus the repo's own gates the criteria name: `pnpm check:arch:serial` (god-module ceiling), the
ratchet suites (`route-body-validation`, `api-response-validation`, `fetch-in-effect`,
`split-responsibility`, `repository-table-ownership`, `status-read`), and the greps quoted
verbatim in § 5 and § 6.
