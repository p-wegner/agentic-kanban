# Delivery via real PR/MR + CI — modernization plan for agentic-kanban

Goal: **a work item is complete only when a merge/pull request has been opened, CI has run green
on it, and it has been merged — with the board reflecting the wait, the failure, and the eventual
merge.** Today a work item is complete when the agent that did it says it is done, a *local*
`verify_script` gate passes, and its branch is merged into a *local* base branch by the board
itself.

Produced with the `modernization-plan` skill. This document is the *plan*; nothing in it has been
implemented. **Scope is delivery only** — the tracker question (Jira/Linear as source of truth) is
the sibling plan's, multi-developer operation is nobody's yet.

## Provenance

- Repo `agentic-kanban` at **`0610ecc174`** (2026-09-01 01:13 +0200), tree clean apart from a
  sibling session's untracked plan file. Metrics snapshot: `code-metrics analyze . --days 180` of
  that commit, 2026-09-01 00:06–00:13 UTC, **3,118 files** in the graph (1,813 production,
  1,305 test, measured separately). Engine `code-metrics` 0.2.0. HEAD was re-checked after the
  fan-out and had **not** moved; it moved to `ec15e4f635` while §7's review rounds ran (another
  session merges in this checkout), so every line/rank anchor below is against `0610ecc174` and
  should be re-resolved before use.
- **Graph reach** (`provenance.resolution_coverage`): TypeScript imports **8,671 / 8,677 =
  0.9993** — the six unresolved specifiers are build-output paths (`../dist/cli/index.js`) and
  three `.js` siblings. Above the 0.95 bar, so coupling / fan-out / dependents numbers are
  **usable as stated**, not floors. Channels unmeasured: none. **`calls: absent:
  no_call_resolution_channel`** — the engine has no call-resolution channel at all, so every
  "nothing calls X" / "N writers" figure in this plan is a **grep** recorded in §6, never a metric.
  One further limit found during §6 and used throughout: **`import type` is not an edge in this
  graph**, so `graph --dependents-of` under-reports any module whose main export is a type (F4).
- **Prior plans for this goal — this plan EXTENDS one and complements the other.**
  - [`2026-08-26-team-capable-modernization-plan.md`](2026-08-26-team-capable-modernization-plan.md)
    (snapshot `056f77e230`): its capability **C5** and its seam **S3** are exactly this goal,
    bundled with Jira and multi-developer operation. **Fate: extended, and corrected in one
    load-bearing place.** Its decisions are inherited and cited where used; its §7 finding 4
    ("`landing` is a **branch at the one `merge-executor` call site**, not a strategy port") is
    **refuted by F1** — there are four base-advancing paths, three of which never reach
    `merge-executor`. Its numbers are second-hand and were re-derived (F4, F9).
  - [`2026-09-01-external-tracker-source-of-truth.md`](2026-09-01-external-tracker-source-of-truth.md)
    (today, uncommitted, another session): declares delivery/CI *"explicitly out of scope"*. No
    overlap; nothing here contradicts it.
- Goal framing §1 (12 capability rows) → **3 seams** → **3 read-only subagents**. Concurrency
  actually run at: **2, then 1**. `fleet gate --count 3` returned *"BLOCKED: room for 2"*; two were
  released, and the re-check with both live returned *"room for 0 — CPU at 91 %, 2.1 GB usable"*,
  so the third seam was serialised behind them rather than run in a wave of three.
- **All three seam reports are marked `prior-plan-informed`.** The skill's rule is to withhold a
  prior plan from the seam agents; that is unenforceable here, because the prior plan lives in
  `docs/plans/` inside the repo they were told to read, and all three found and cited it
  unprompted. Their agreement with it is therefore **not independent corroboration**, and every
  claim this plan takes from them was re-derived in §6.
- **Verification: 10 load-bearing claims attacked (§6)** — 6 confirmed, 1 weakened, 3 refuted or
  corrected. 3 further claims are carried as `unverified` below that table.
- **Three adversarial review rounds** (§7), each of which re-cut a phase: round 1 moved publishing
  ahead of the extraction, round 2 moved it ahead of the *merge*, round 3 added the dwell and the
  single arming-write hook. A fourth round is owed and is recorded as a shortcoming (§8).
- **Adversarial review: §7** — three rounds, one fresh generalist reviewer each: round 1 full
  rubric R1-R8, round 2 scoped to the re-cut phases plus R7, round 3 narrow on Phase 1 and the
  2a/2b split.
- **Cost of producing this plan.** 33 `code-metrics` invocations (1 `analyze`, 24 `query`/`graph`
  runs of which 12 were repeats after an argument-form error, plus `candidates`, `refactor
  --boundaries`, `graph --stats`, `graph --module-graph`, `scorecard`, 2 `graph --dependents-of`);
  6 subagents (3 seam + 3 adversarial reviewers); subagent tokens 165k / 149k / 158k for the seam
  agents and 122k / 103k / 99k for the review rounds — ~797k in total, plus this session.
- **NOT measured / not trustworthy here.** `--rework` reads **94 % of 1,421 changes** — an artifact
  of agent commits using `fix:` for follow-ups; cited nowhere, no exit criterion. Class metrics are
  **unmeasured, not healthy** (functional TS). All **26 scorecard targets are defaulted**
  (`0 targets declared`) and therefore advisory — no scorecard cell is an exit criterion here.
  `--tangle` is not comparable across snapshots without `--history-ref`. Not measured at all: this
  repo's CI queue times, GitHub API rate limits, and the runtime of a fast lane that does not exist.

## 1. Goal as capability delta

| # | Capability (target state) | Quality demanded | Seam | Today |
|---|---|---|---|---|
| D1 | A finished item's branch is **pushed to a shared remote** | strategy as port | S1 landing | the only outbound push is worker→board `refs/kanban/incoming/*` (`worker/worker-repo.ts:245`) |
| D2 | The board **opens/refreshes a PR** for the item | strategy as port; externally contracted | S1 | `CLAUDE.md:13` "PR creation skipped — manual merge only"; `github-handoff-draft.service.ts` writes a full PR body nobody posts |
| D3 | **CI on the PR** contributes the verdict that gates the merge | strategy as port; async-capable | S2 gate | `pre-merge-gate.service.ts:156` runs a local `verify_script`, 20–40 min |
| D4 | Completion is **asynchronous** — Done only after the remote merge is observed | async-capable | S3 completion | the merge tail runs inline after `runMergeCore` in all four drivers |
| D5 | The board **shows the wait** (awaiting CI / CI red) | observable | S3 + UI | statuses are Backlog…In Review, AI Reviewed, Done; nothing means "waiting on a machine elsewhere" |
| D6 | **CI red routes back** as a fix turn on the same workspace/PR | observable; async-capable | S3 / S2 | a failing local gate already loops back, synchronously |
| D7 | **Merge happens on the remote**; the local checkout follows | multi-instance safe (weakly) | S1 | `git-service/merge.ts:400` advances `refs/heads/<base>` by CAS and `:474` `reset --hard`s the checkout |
| D8 | The **merge tail** fires from the remote merge event | async-capable | S3 | ~20 steps inline, across two divergent code paths |
| D9 | A **human-merged** PR still completes the item | idempotent | S3 | not representable |
| D10 | Landing mode is **switchable and reversible** | strategy as port | S1 | hard-wired local path |
| D11 | Reconcilers/sweeps **stop auto-merging locally** under remote landing | multi-instance safe | S1 | `done-unmerged-invariant-sweep.ts:435` auto-merges, ≤3/cycle |
| D12 | Remote/CI **credentials** live outside `kanban.db` | secret-safe | S1 (config) | no secret notion anywhere; two SHA-256 hash columns are the only precedent |

**Out of scope by construction** (no capability row): the tracker/source-of-truth question;
multi-user identity, tenancy, cloud hosting (`CLAUDE.md:14` "Local only"); the worker fleet's
protocol; everything in §4.

## 2. What the metrics say about the ground we build on

Snapshot `0610ecc174`, 180 d.

- **Kernels** (`graph --stats`, transitive most-depended-on): `shared/src/schema/index.ts`
  **580**, `server/src/db/index.ts` **251**, `shared/src/lib/error-message.ts` 226. Every schema
  change this plan makes is therefore **a new table, never a new column on a hot table** — and
  `schema/workspaces.ts:7` independently pins that: *"38 columns, and it should not become 39"*,
  enforced by `workspaces-table-width-ratchet.test.ts` (F10).
- **Hot-on-seam files** (`query --class refactor_first`, 336 files in class): `exit-workflow.ts`
  **0.871** (#3, `introduce_event` priority 0.5815, 8 cross-module calls),
  `workspace-merge.service.ts` **0.844** (#6), `monitor-auto-start.ts` **0.769** (#15,
  `split_responsibility` 0.7345 → 6 groups), `monitor-cycle.ts` **0.764** (#16,
  `split_responsibility` 0.7182 → 4 groups, one of them literally
  `canStartMerge / mergeBlockedByBackoff / processProjectGroup`), `routes/workspace-actions.ts`
  **0.763** (#17), `merge-workflow.ts` **0.709** (#27), `auto-merge-orchestrator.ts` 0.691,
  `pre-merge-gate.service.ts` 0.681. **The merge *drivers* are already in the top 40 — the
  base-advancing *primitives* are not** (`merge-executor.service.ts`, `merge-train.service.ts`
  0.2817, `done-unmerged-invariant-sweep.ts`, `worker-remote-sync.service.ts` are all outside the
  336-file class), which is exactly why F1 needed a grep rather than a ranking. That is the strongest argument for the ordering in §5: the new
  behaviour goes into *new files* behind a mode flag, and the splits the engine prescribes come
  after the PR/CI semantics are known, not ahead of them.
- **Boundaries the work crosses** (`refactor --boundaries`): `server ↔ shared` co-change **0.49**
  over 9 file pairs (w=1,459 edges, prescribed `introduce_facade`), `client ↔ server` 0.25,
  `mcp-server ↔ server` 0.23. `--tangle`: **48.6 %** of 3,007 logical changes touch ≥2 modules,
  **17.8 %** ≥3; containment `shared` **35 %**, `mcp-server` **23 %**. Adding a state the UI must
  render is a ≥3-module change by construction.
- **Hidden dependencies** (`--module-crime`, co-change with no import edge): `client ↔ server`
  1,051 shared change sets, Jaccard **0.372**; `mcp-server ↔ server` 205 / 0.098. D5 lands exactly
  on the first pair — the DTO the client reads is kept in sync by hand.
- **The existing event bus is far smaller than every prior count claims** — F4. Ten direct
  import-graph dependents (nine of them tests), ~52 non-test files importing only its *types*,
  **7** importing the factory as a value, **134** `.broadcast(` call sites, **3** real subscriber
  registrations (`routes/projects.ts:232`, `core-services-wiring.ts:41`, `monitor-setup.ts:692`).
  It is a WebSocket **invalidation** channel (`{type, projectId, reason}`, `board-events.ts:19-21`),
  not a domain-event bus. The three `introduce_event` prescriptions can land on it only after a
  payload channel *and* a subscriber registry exist — real work, not a free ride. This plan does
  **not** schedule it (§4, §8).
- **Scorecard** (all targets defaulted, advisory): composite 88.8, 14/26 at target; the cells that
  touch this seam are *files with complex functions* 434 and *centre of gravity* 0.447. Context
  only; no exit criterion rests on them.
- **Existing fitness machinery to extend, not duplicate**: `.github/workflows/arch-gate.yml` runs
  `pnpm check:arch` + `pnpm openapi:check` on every `pull_request` into master (the `coverage` job
  is explicitly `if: github.event_name != 'pull_request'`);
  `packages/server/src/__tests__/status-write-ratchet.test.ts` is a grandfathered tighten-only
  write ratchet; `workspaces-table-width-ratchet.test.ts` pins the schema; **166 files** carry a
  `@gate:always-run` marker (F9).

## 3. Seams and their components

Class: **kernel** (top depended-on / large blast radius) · **hot-on-seam** (in `refactor_first` or
carrying a prescribed move) · **cold-on-seam** · **contract** (co-change, no import edge). Sizes
S/M/L; the repo declares no per-finding costs, so no days are promised.

### S1 — Landing: push, PR, base-ref mutation, reconcilers, credentials

| Component | Files | Role today | Change for the goal | Class | Size |
|---|---|---|---|---|---|
| Merge primitive | `shared/lib/git-service/merge.ts` (`mergeBranch:205`, `advanceRefWithCas:75`, `syncWorkingTreeHard:474`) | merge-tree, commit-tree, CAS `update-ref`, `reset --hard` | untouched; must simply **not run** under `remote_pr` | cold-on-seam | S |
| Merge core | `services/merge-executor.service.ts:101` (3 `runMergeCore` callers) | 1 of 4 base-advancing families | one mode guard | cold-on-seam | S |
| **The other three base-advancing paths** | `merge-train.service.ts:183`, `done-unmerged-invariant-sweep.ts:435`, `worker-remote-sync.service.ts:63,:102` | land or advance `refs/heads/*` **without** `merge-executor` | each needs its own guard — F1 | cold-on-seam (`merge-train.service.ts` risk **0.2817**, not in the 336-file class; the 0.688 in earlier drafts was `services/merge-queue.service.ts` #35) | M |
| Merge drivers | `startup/merge-workflow.ts:452`, `auto-merge-orchestrator.ts`, `monitor-cycle.ts`, `exit-workflow.ts:499,620`, `services/workspace-merge.service.ts` | decide, execute, and run the tail inline | branch on landing mode; tail moves behind `finalizeLandedIssue` | hot-on-seam (0.709 / 0.691 / 0.764 / **0.871** / 0.844) | L |
| Reconcilers | `ancestor-branch-reconciler.ts`, `hand-merged-*`, `silently-merged-*`, `merge-run-reconciler.ts`, `base-branch-health-reconciler.ts` | ancestry vs the **local** base — stated as doctrine at `git-service/rebase.ts:86-88` | compare `origin/<base>` after fetch | cold-on-seam | M |
| Outbound git | `git-http.service.ts`, `worker-remote-sync.service.ts`, `worker/worker-repo.ts:245`, `shared/lib/git-exec.ts` | board-to-worker smart-HTTP; the only working push | `git-exec` is the sanctioned spawn point for a board-to-origin push | cold-on-seam | S |
| PR body | `github-handoff-draft.service.ts` | a complete Markdown PR description, stored as an artifact, never posted | becomes the PR body | cold-on-seam | S |
| Landing-mode config | `shared/lib/merge-policy.ts` (`MergeStrategy`), `dynamic-preference-keys.ts`, `checked-preference-write.ts` | selects **who** merges, never **where** | add an orthogonal `landing` axis in the *same* module and pref shape | cold-on-seam | S |
| Credentials | none — `workers.tokenHash`, `worker_git_tokens.tokenHash` (SHA-256) are the only secret-shaped columns; one keychain-adjacent mention repo-wide | no secret notion; nothing encrypted at rest | `AGENTIC_KANBAN_GH_TOKEN` env var only; `remote-spec-env.ts:65 looksSecretEnvKey` already blocks `GH_`/`GITHUB_` from crossing to a worker | cold-on-seam (new) | S |
| Branch namespace | `showdown.service.ts:73` (`feature/ak-<N>-<slug>`), `shared/lib/branch.ts:46`, `server/src/services/worktree-ports.ts:26`, `lib/git-receive-guard.ts:24,:143` | `refs/kanban/*` reserved for the fleet; TCP ports derived from the `ak-<N>` token | PR branches are `dev/<who>/ak-<N>-<slug>`, **on origin only** | cold-on-seam | S |
| Settings UI | `client/components/SettingsPanel.tsx` **0.906 (#1 in the repo)** | 80+ flat keys | **deliberately untouched in every phase** — the mode is a pref set by CLI/env | hot-**off**-seam, see section 4 | — |

### S2 — Verification evidence and the merge gate

| Component | Files | Role today | Change for the goal | Class | Size |
|---|---|---|---|---|---|
| Gate runner | `services/pre-merge-gate.service.ts:156`, `pre-merge-gate.types.ts`, `pre-merge-gate-installs.ts` | the only code that computes a fresh verdict: `verify_script` + boot/render smoke + E2E lane | becomes one *source* among two | hot-on-seam **0.681** | L |
| Gate owner + token | `services/merge-gate-token.ts` (`resolveMergeGateShas:61`, `contentMatch:127`), `merge-gate-evidence.ts` (`movedDuringGate:31`) | SHA-pins a verdict to (branchSha, baseSha); 15-min age unless both tips match | add `source: local or ci` plus run id/URL; key on the **pushed** SHA; drop the age window for a SHA-pinned CI verdict | cold-on-seam | M |
| Second gate lane | `services/merge-queue-train.ts:227` (direct `runPreMergeGate`), `merge-train.service.ts:148-155` (`landMergeTrain` deliberately does not re-gate) | gates a train once for N tickets | F2: a per-PR gate is per-ticket by construction; trains **refuse** under `remote_pr` rather than silently bypass | `merge-queue-train.ts` hot-on-seam; `merge-train.service.ts` **0.2817**, cold | M |
| Bypasses | `workspace-merge-gate.ts:490-540` and `:528` (red-debt softened mint), `done-unmerged-invariant-sweep.ts:404` (`gateSkipExplicit`), `pre-merge-gate.service.ts:690` (null `projectId` passes), `:644,:659` (`unverified:true` still passes), `merge-gate-tree-memo.ts:145` (in-process tree memo) | documented escape hatches | each re-decided under `remote_pr`; the tree memo is single-box state and would mislead | cold-on-seam | M |
| Persistence | `repositories/merge-gate.repository.ts`, `schema/workspace-merge-gate.ts` | one latest verdict per workspace | a second source and a *pending* state mean new rows, not new columns | cold-on-seam | S |
| Tiering / fast lane | `services/pre-merge-gate-tier.ts` (`full`, `scoped`, `scoped-base-watch`, `impact`), `scripts/test-mine.mjs` (`KANBAN_TEST_PACKAGES`, `KANBAN_TEST_FILES`, `KANBAN_TEST_SELECTOR`), 166 `@gate:always-run` files | scopes the local suite | the same three env vars can drive a CI job verbatim — the cheapest path to a fast lane | cold-on-seam | M |
| Local-box throttles | `lib/machine-verify-lock.ts`, `verify-chain-semaphore.ts`, `jvm-build-semaphore.ts`, `verify-budget.ts` (`VERIFY_SCRIPT_TIMEOUT_MS = 45 min`) | serialise heavy runs on one box | meaningless for a hosted verdict; must not serialise *waiting* | cold-on-seam | S |
| CI itself | `.github/workflows/arch-gate.yml`, `docker-smoke.yml`, `security-scan.yml` | on `pull_request`: `check:arch`, `openapi:check`, docker smoke, security scan. **The test suite never runs on a PR** | those jobs are the *first* CI evidence; the fast lane is Phase 3 | cold-on-seam | M |

### S3 — Completion state machine and how the board shows it

| Component | Files | Role today | Change for the goal | Class | Size |
|---|---|---|---|---|---|
| Issue-status authority | `shared/lib/workflow-engine/status-transition.ts:33` (sole UPDATE at `:86`) | legality and node sync | new non-terminal states and their legal edges | cold-on-seam | S |
| **Writers around the authority** | `workflow-engine/transitions.ts:190,:244`, `workspace-init.ts:94`, `repositories/issue-service.repository.ts:148,:204,:377`, `project-registration.repository.ts:36` | write `statusId` directly; `transitions.ts:190` writes **Done** on reaching an `end` node | F3: the ratchet's `scanRoots` are `server/src` and `mcp-server/src` only, so the three `packages/shared` sites are unwatched | cold-on-seam | M |
| Workspace-status authority | `shared/lib/workspace-status.ts:126`, `workspace-liveness.ts:19-27,:38-42` | terminal invariant; **"merged" is not a state**, it is `closed && mergedAt != null` | needs a *non-terminal* in-flight state, which the terminal guard currently forbids | cold-on-seam | M |
| The merge tail | `startup/merge-workflow.ts:452-619` (path A, 12 steps), `merge-cleanup.service.ts:243-303` + `workspace-merge-cleanup.service.ts:85-146` (path B, ~13 steps) | worktree/branch cleanup, `mergedAt`, Done, loop advance, learning step, follow-up autostart, handoff draft | extract `finalizeLandedIssue(workspaceId, mergeSha)`; the non-idempotent third (verify session, `runLearningStep`, `autoStartFollowups`, `autoStartUnblockedDependencyIssue`, `createGithubHandoffDraft`, OpenSpec apply) must be marker-guarded before a poller may call it | hot-on-seam 0.844 | L |
| Async precedent to copy | `schema/workspace-merge-run.ts` + `startup/merge-run-reconciler.ts`, `schema/merge-trains.ts:19-26`, `workspace_merge_backoff`, `merge-job.service.ts` + `GET /:id/merge-status` | durable in-flight markers, reconciled at boot | the PR/CI marker table copies these; **no outbox and no generic job table exist** | cold-on-seam | — |
| Board projection | `shared/lib/board-status-classifiers.ts:64-83` (`mergeState.bucket`) | the one presentation slot that already exists | additive new buckets | cold-on-seam (`board-status-classifiers.ts` risk **0.3427** shared / 0.2671 server; the 0.703 in earlier drafts was `services/board-status.ts` #30) | S |
| Client | `IssueCard.tsx` 0.769, `WorkspaceCard.tsx`, `WorkspacePanel.tsx` **0.869**, `BoardColumn.tsx` 0.709, `lib/apiResponseSchemas.ts` | render status, `readyForMerge`, `mergedAt` | one new badge fed by `mergeState.bucket`, one new DTO field | hot-on-seam + **contract** (client-server Jaccard 0.372) | M |

## 4. Do-not-touch — hot, off-seam

No capability row reaches these. Listed with their risk so nobody "fixes them while they are in
there", and so a diff touching them is visibly out of scope.

| File | Risk | Why it is not this plan's business |
|---|---|---|
| `client/components/SettingsPanel.tsx` | **0.906 (#1)** | the landing mode is a pref set by CLI/env; no panel change is scheduled in any phase |
| `client/components/Layout.tsx` | 0.884 (#2) | unrelated |
| `server/services/project.service.ts` | 0.844 (#5), `split_responsibility` 0.7061 | project registration — the tracker plan's ground |
| `server/server-start.ts` | 0.838 (#7) | composition root; touched only to wire one poller in |
| `BoardToolbar.tsx` 0.831, `IssueDetailPanel.tsx` 0.800, `ButlerView.tsx` 0.776, `CreateIssuePanel.tsx` 0.762, `CreateIssueForm.tsx` 0.758, `DiffViewer.tsx` 0.736 | — | unrelated UI |
| `routes/issues.ts` 0.776, `routes/projects.ts` 0.754, `services/issue.service.ts` 0.776 (`split_responsibility` 0.6895, `introduce_event` 0.463) | — | the tracker seam's files; the sibling plan owns them |
| `services/plugin-loop.service.ts` | 0.736 | plugin loops land through the same drivers but add no capability row |
| **a payload channel and subscriber registry on `services/board-events.ts`** | — | the three `introduce_event` prescriptions are real, but F4 shows the bus is far smaller than assumed and turning it into a domain-event bus is its own project. Deliberately out; this plan uses a marker table plus a poller, and says so in section 8. |

## 5. Phases

The skeleton's Phase 3 ("multi-instance / concurrency / shared state") **has no capability row in
this goal** and is therefore replaced by "CI becomes the gate of record"; the multi-developer half
belongs to the 2026-08-26 plan. Sequencing is dependency-first, then payoff over effort. Every exit
criterion records its **phase-start value** and the thing that would turn it red.

### Phase 0 — Decisions, the truth about CI, safety net  (no behaviour change)

Goal: the decisions Phase 1 cannot proceed without, the fitness machinery extended to watch what
this plan is about to change, and a recorded trace that proves "flag off = today".

- **P0.1 — Decision record `018-delivery-mode.md`.** (S) It must supersede or narrow, by name:
  `CLAUDE.md:13` ("PR creation skipped — manual merge only"), `CLAUDE.md:14` ("Local only — no
  cloud/multi-tenant/OAuth", which must be narrowed to *inbound*: the board still serves nobody and
  hosts nothing, but it now makes an **outbound** call to a code host, and under `remote_pr` it
  cannot land work offline at all), `CLAUDE.md:15` ("`#N` ... never a
  GitHub PR", becoming "`#N` is a kanban issue; a PR is `PR #n`"), `docs/prd.md:228` (non-goal "PR
  creation (manual merge only)") and `docs/prd.md:271` (a "not committed" future-work list rather than a non-goal — narrowing it is
  a weaker act than narrowing `:228`), and `git-service/rebase.ts:86-88` (the "no
  push" doctrine, in code). It **narrows** `docs/decisions/016` rather than overturning it: 016
  rejected putting the ~25-minute *coverage* job on PRs; it did not reject a fast lane. Decisions
  to fix: (a) **merge-commit PRs only** — the API merge always passes `merge_method:"merge"`,
  because the ancestry invariants in six reconcilers and `merge-train.service.ts:20-34` assume no
  squash and no rebase; (b) **`AGENTIC_KANBAN_GH_TOKEN` in the environment, never in `kanban.db`**
  — the board API is unauthenticated on loopback, `GET /api/preferences` would return a stored
  token in cleartext, and the board writes `CLAUDE.local.md` into the same worktree for the agent
  to load as memory (`worker/worker-repo.ts:159`); (c) **polling, not webhooks** — the board is
  local-first and has no inbound reachable endpoint; (d) **GitHub first**, GitLab unscheduled;
  (e) **the local gate stays the correctness authority** until Phase 3 measures a fast lane — CI
  evidence is *added*, never substituted, in Phases 1 and 2.
  (f) **the token is read once at the delivery-service boundary and scrubbed from the agent spawn
  environment** — `remote-spec-env.ts`'s `looksSecretEnvKey` blocks `*TOKEN*` keys from crossing to
  a *worker*, but `agent.service.ts:542` spawns the local agent CLI with "the full converged env",
  so a board-process token would otherwise reach every agent, in a worktree where the board also
  writes `CLAUDE.local.md` for that agent to read; (g) **which remote is the delivery remote** —
  this checkout already has two (`origin` = a personal GitHub account, `gitlab` = an internal
  GitLab project under a different name), so the account, its Actions minutes and its bus factor
  are a decision, not a Phase-1 discovery (§9 O6); (h) **the delivery remote's initial state** —
  a fresh mirror, or an existing repository whose base is behind by the whole local-only history
  (`rebase.ts:86-88`) — plus explicit acceptance that until Phase 2 the base advances arrive as
  bulk, un-CI'd fast-forwards, and that **any branch protection on that base invalidates P1.2**;
  and (i) **what `<who>` is** in `dev/<who>/ak-<N>-<slug>`, since this repo has no identity notion.
- **P0.2 — `code-metrics baseline pin` on `0610ecc174`.** (S)
- **P0.3 — Extend two ratchets, add one.** (M)
  - `status-write-ratchet.test.ts`: add `packages/shared/src` to `scanRoots` (today `server/src`
    and `mcp-server/src` only, `:38-41`). Newly visible raw `statusId` writers:
    `workflow-engine/transitions.ts:190`, `:244`, `workspace-init.ts:94`. Widening also newly
    exposes the two **authority** modules that have since moved into `shared`
    (`status-transition.ts:87`, `workspace-status.ts:189`) — they must be added to
    `AUTHORITY_FILES`, whose single existing entry still points at a `server/src/repositories/`
    path its own comment says has moved. So the phase-start value is **3 grandfathered writers +
    2 authority-file corrections**, not "3". Tighten-only.
  - **New `base-ref-advance-ratchet.test.ts`**, defined over the **git verb list at the sanctioned
    spawn points** — every `git-exec.ts` / `execGit` / `gitExec*` call whose argv begins
    `merge | rebase | reset | commit | pull | push | fetch | update-ref | branch | checkout |
    switch | worktree add | symbolic-ref`, plus the named helpers `mergeBranch` and
    `advanceRefWithCas` — with two companion assertions: `git-receive-guard`'s allowed inbound
    prefix set is unchanged (a loosened guard would let a *worker* choose a `refs/heads/` name,
    which no source-text ratchet can see), and no `gitExec` call site passes a non-literal argv
    array. A vocabulary built from function names alone misses `execGit(["merge", …])`, the
    dependency-injected alias at `done-unmerged-invariant-sweep.ts:121`
    (`gitMerge: deps.mergeGitBranch ?? mergeBranch`), the `reset --hard` at `merge.ts:477`, the
    `rebase` at `rebase.ts:109,:194`, `worktree add -b` at `worker-repo.ts:144`, and every
    `commit`. **This is a loudness device, not a proof** (§8). Phase-start set: **3 base-advancing merges**
    (`merge-train.service.ts:183`, `done-unmerged-invariant-sweep.ts:435`,
    `worker-remote-sync.service.ts:63/:102`); **4 `branch -f` sites**
    (`shared/lib/git-service/worktree.ts:305`, `git-service/branch-attach.ts:22` and `:47`,
    `merge-train.service.ts:74`), each recorded known-safe with its reason — the first three point
    a *workspace* branch at a base or a head, the fourth builds the train ref; **the base-advancing
    `push <remote> <base>` added by P1.1**, recorded known-safe because it fast-forwards the
    *remote* to a base the local repo already has; **2 known-safe non-base ref writes** (`merge-train.service.ts:102` to `refs/kanban/train/*`,
    `workflow-fork.service.ts:613` to a fork parent in a worktree). Reasons carried in the style of
    `always-run-marker-ratchet.test.ts`'s `KNOWN_SAFE_UNMARKED`. **This ratchet is the mechanical
    answer to F1.**
  - `.codemetricsrc [architecture]` plus a `.dependency-cruiser.cjs` rule: nothing outside
    `packages/server/src/services/delivery/**` may import the PR client. It is added at **`warn`**
    here only because the module does not exist yet, and is promoted to **`error` in Phase 1**, in
    the same commit that creates the module — a `warn` rule cannot turn `pnpm check:arch` red, so
    no exit criterion in this plan rests on one.
- **P0.4 — The recorded trace.** (M) One captured end-to-end run of exit, review, gate, merge, tail
  with the flag off, replayable as a test, asserting the ordered 12 steps of path A and 13 of path
  B — **and the review-exit ordering as well** (gate, `runColdCloneGate`, the `#629`
  committed-changes check, `armReadyForMerge`, learning step, `autoMerge`), because that is the
  sequence Phase 1 modifies and a tail-only trace cannot see a publish inserted inside it — with the non-idempotent tail steps line-anchored (`merge-cleanup.service.ts:243-303`,
  `merge-workflow.ts:565`). Re-run after every item in Phases 1 and 2. Without it,
  "behaviour-preserving" is an assertion.
- **P0.5 — Establish what CI actually says today. STOP-GATE.** (M) `BACKLOG.md` #834 records that
  the Linux CI run has never been confirmed green after #828, and `docs/decisions/016` records a
  master run that was *"red — master carries failing tests from concurrent fleet work"*. A plan
  whose point is "merge only when CI is green" cannot start against an unknown-colour CI. Run
  `arch-gate.yml` on a no-op PR and one full Linux suite run; record green/red per suite. P0.1(g) must be decided first — the run needs a remote and a credential. **If the
  PR-triggered jobs are not reliably green, nothing after Phase 1's publish slice starts** — it
  would gate every merge on a signal that is red for unrelated reasons, and the team would learn
  to override it within a week.

Exit criteria:

| Criterion | Phase-start value | What would turn it red |
|---|---|---|
| `docs/decisions/018-delivery-mode.md` exists, each of the five contradicted texts links to it, and (f) and (g) are decided with a named owner | 0 of 5 linked; both open | writing the record without touching `CLAUDE.md`, `prd.md`, `rebase.ts`; leaving the remote or the token owner unnamed |
| `status-write-ratchet` green with `shared/src` in scope **and** `AUTHORITY_FILES` pointing at paths that exist | 3 grandfathered writers, 1 stale authority path, 2 authority modules unlisted | a fourth raw `statusId` write anywhere, `shared` included; a stale authority path left in |
| `base-ref-advance-ratchet` green over the full ref-mutation vocabulary | 3 merges + 4 `branch -f` + 2 non-base, all reasoned | any new `mergeBranch`/`update-ref`/`branch -f`/`checkout -B`/`push`-to-`refs/heads` caller |
| the P0.4 trace replays green | recorded, green | any reordering of the tail |
| `pnpm check:arch` green **and** the colour of every PR-triggered suite **recorded** from a no-op PR run | **unknown** (#834) | no run produced at all. *Green* is not required here — Phase 1 does not gate on CI; "reliably green over 5 consecutive runs" is the **entry gate to Phase 2**, listed there |
| `compare --history-ref 0610ecc174`: no production file's summed CC up | CC unchanged | writing logic instead of tests and records in Phase 0 |

Risks: P0.5 may reveal that CI cannot be made green cheaply. That is a finding, not a failure — it
moves the fast-lane work (P3.1) in front of everything else, and it is the single most likely
reason this plan's shape changes.

Do-not-build in Phase 0: any *product* code that touches git (the P0.5 no-op PR is a manual
run, not a feature), any schema change, any UI.

### Phase 1 — Publish, and wait for CI once  (the first user-visible outcome)

Goal: **a real PR whose diff is the ticket, on a real remote, with real CI running on it — and the
board actually waiting for that CI at least once.** The merge still happens locally. No landing
mode, no guards, no completion-state change: those are Phase 2, and they are only needed once the
merge itself moves.

This ordering answers round 1's R8: the unknown that can invalidate everything is whether this
org's CI says anything useful (F6, P0.5), and publishing answers it for the price of one additive
service instead of behind an L-sized tail extraction.

Two corrections from later review rounds shape the phase, and both are behaviour changes rather
than pure additions — the phase is **not** "the board behaves exactly as today":

- **Publish before the local merge, not after** (round 2). `git-service/rebase.ts:86-88`, verbatim:
  *"local master can be many commits ahead of a stale origin/master"*. Publishing at the end of the
  tail would produce a PR whose diff is every local-only commit rather than the ticket, against a
  branch `merge-executor.service.ts:236` has already deleted.
- **The board must hold the merge, or the PR dies before CI speaks** (round 3). A foundational
  ticket merges synchronously at `exit-workflow.ts:497`; every other ticket waits one 30-second
  orchestrator tick. Pushing the advanced base then lets the host close the PR as merged, usually
  inside arch-gate's own runtime. Without a dwell, Phase 1 buys a PR that exists for a minute and
  answers nothing.

- **P1.1 — One publish hook, at the `readyForMerge` arming write.** (M) *Not* at "gate pass": the
  gate has six entry points — `runGateWithEvidence` at `exit-workflow.ts:434`,
  `workspace-merge-gate.ts:407`, `monitor-cycle.ts:470` and `:663`, `merge-queue-train.ts:227`
  calling `runPreMergeGate` directly, and the in-lock re-gate at `pre-merge-gate.service.ts:715`.
  Only the first is review exit; `monitor-cycle.ts:470` lands an idle In-Review workspace that
  never had one. All of them converge on the arming write, so that is the single insertion point,
  and the other five are recorded as deliberately non-publishing with reasons — the same
  enumeration discipline F1 and F2 came out of.
- **P1.2 — `services/delivery/github-pr.service.ts`.** (M) In order: fast-forward the delivery
  remote's `<base>` (**fast-forward only, never `--force`**; on divergence it refuses, reports and
  opens no PR), push `dev/<who>/ak-<N>-<slug>`, create or refresh the PR through the GitHub REST
  API with `fetch` — **no new dependency**; body from `github-handoff-draft.service.ts` — the draft generation moves here and is *removed*
  from the tail in P2a.1, so it is generated once, at publish. Record the
  **pushed** SHA in `head_sha` at publish time, so 2b's evidence minter has it without re-deriving
  from a worktree that may be gone (`merge-gate-token.ts:61` reads the worktree HEAD today). The
  `ak-<N>` token is preserved because `server/src/services/worktree-ports.ts:26` parses it. `<who>`
  needs a definition — the repo has no identity notion — so P0.1 fixes it (a configured handle,
  defaulting to the git user). Re-runs are explicit: open PR → refresh with force-with-lease;
  merged or closed PR with new commits → a new branch suffix keeping `ak-<N>`, and a new row; no
  commits ahead of base → publish nothing. In the same commit the P0.3 depcruise rule goes to
  **`error`**.
- **P1.3 — `workspace_pull_request` table** at its full 13-column shape (`workspace_id`,
  `provider`, `number`, `url`, `head_sha`, `base_sha`, `state`, `ci_conclusion`, `ci_run_url`,
  `opened_at`, `merged_at`, `last_polled_at`, `landed_at`) so Phase 2 needs no migration, with a
  **unique index on `(workspace_id)` for open rows** plus `head_sha`, and a boot reconciler —
  modelled on `workspace_merge_run` and `merge-run-reconciler.ts`. **A new table, not columns on
  `workspaces`** (F10). The `finalized_at` idempotency marker deliberately lives on
  `workspace_merge_run` instead, because a **local** landing has no PR row and Phase 4 routes it
  through the same function. (M)
- **P1.4 — A read-only check-status poller.** (S) A 60-second tick writing `ci_conclusion`,
  `ci_run_url`, `last_polled_at` onto open rows, capped at N rows per tick so the unmeasured rate
  limit has a bound. **No merge authority, no gate participation.** Phase 2's
  `pr-landed-reconciler` extends it rather than adding a second mechanism.
- **P1.5 — The dwell.** (M) With publishing on, the merge trigger — both the synchronous
  `autoMerge` at `exit-workflow.ts:497` and the orchestrator tick — waits until the poller records
  a **terminal** `ci_conclusion` or a bounded timeout (20 minutes, configurable) elapses, then
  merges locally **regardless of colour**. This is the phase's one real behaviour change, and it is
  the point: it is the cheapest honest test of whether this team can wait for this CI at all,
  before Phase 2 makes the wait mandatory. A red conclusion is surfaced on the card, not enforced.
- **P1.6 — One badge.** (S) `IssueCard` and `WorkspaceCard` read the existing `mergeState.bucket`
  plus the new row: `PR #n - checks running / checks red / checks green`. One DTO field in
  `apiResponseSchemas.ts` and the workspace summary — the client-server pair (Jaccard 0.372) is a
  hand-kept contract, so it lands on both sides with a shared type.
- **P1.7 — One kill switch**, a per-project pref through the existing `dynamic-preference-keys.ts` /
  `checked-preference-write` path, **off by default**, disabling publish, poller and dwell
  together. Nothing needs draining: nothing has been landed remotely. (S)

Exit criteria:

| Criterion | Phase-start value | What would turn it red |
|---|---|---|
| **The demo**: a finished ticket produces a `dev/...` branch on the delivery remote, an open PR, the PR-triggered jobs running on it, a coloured badge, and a local merge that happened **after** a terminal conclusion | **0 PRs ever opened by the board** (F8: zero `@octokit` / `pulls.create` / `gh pr` hits) | any step needing a human hand; a merge that raced the conclusion |
| a ticket landed via the **`monitor-cycle` idle path** (`:470`), not review exit, also produced a PR | that path merges with no PR and no review exit | hooking publish to `exit-workflow` instead of the arming write |
| **PR #n's diff contains only ticket #N's commits**, and `origin/<base>` equals local `<base>` when the tail ends | `origin/<base>` is stale by construction (`rebase.ts:86-88`) | publishing after the merge; skipping either base push |
| the base push is **fast-forward-only**; on a diverged remote base the publish refuses, reports, and opens no PR — asserted by a test with a diverged fixture | no base push exists | any `--force`, or a silent skip that still opens a PR |
| the badge shows a **terminal** check conclusion before the local merge on at least 5 of 5 tickets, or the 20-minute timeout is recorded as the reason | not representable | the PR closing before the conclusion arrives (the failure round 3 predicted) |
| P0.4's **review-exit** trace shows the publish call **after** the `#629` committed-changes check and after `armReadyForMerge`, and before any merge trigger | trace covers the tail only today | a publish inserted earlier — which would open an empty-diff PR and leave the tail trace green |
| turning the P1.7 switch off produces **0** pushes and **0** outbound calls **from the delivery module** over a full ticket, spied at `git-exec` and the module's `fetch` | switch absent | publish or poller wired outside the switch |
| `pnpm check:arch` reports **0 warnings and 0 errors** from `no-pr-client-outside-delivery`, rule at `error` | rule absent | any import of the PR client outside `services/delivery/**`; leaving the rule at `warn` |
| `packages/shared/src/schema/index.ts` gains **exactly one** new export, `--dependencies-of` up by exactly 1 | pinned at phase start | a second schema file, or a column on `workspaces` (F10) |
| `compare --history-ref <phase-1-start>`: summed CC of `merge-workflow.ts` and `workspace-merge.service.ts` up by at most +2 each; `exit-workflow.ts` up by at most +4 (the dwell and the arming hook land there, and it is risk **0.871**) | 0.871 / 0.709 / 0.844 — *scores* are the gate; ranks (#3 / #27 / #6) move with other people's churn | putting publish, poll or dwell logic inside those files instead of calling the delivery service |
| no secret in `kanban.db`, **and** `AGENTIC_KANBAN_GH_TOKEN` absent from a spawned agent's environment, asserted in the `remote-spec-env` test family | 0 today; the agent env is **unasserted** | a `github_token_<projectId>` pref; the token surviving into `spawnEnv` |

Risks. (1) **The dwell is a real behaviour change** on the hottest file in the plan — it is bounded
by a timeout and a kill switch, and it is deliberately non-enforcing. (2) The delivery remote is a
personal GitHub account (§9 O6), and **`arch-gate.yml` triggers on `pull_request` into `master`
only** — if the delivery base is not `master`, no job runs at all and the badge stays grey.
(3) The first base push carries the whole local-only history, unreviewed and un-CI'd — P0.1(h)
must accept that explicitly or start from a fresh mirror. (4) Rate limits and API cost unmeasured;
one project, capped poll. (5) A published PR nobody merges is litter — the switch plus the boot
reconciler close stale rows.

Do-not-build in Phase 1: no landing mode, no mode guards, no completion-state vocabulary change,
no remote merge, no gate *decision* change (the dwell delays, it never blocks), no `board-events`
payload channel.

### Phase 2 — The merge moves to the remote  (flagged, strangler, reversible)

Goal: the board stops merging locally for projects in `remote_pr`; the PR is merged by the GitHub
API (or by a human on GitHub) and the tail fires from a poller. This is where "complete only when
merged via a PR that CI ran green on" actually lands. **2a needs no remote and is gated only on
Phase 0; the CI entry gate applies to 2b.**

**2a — The machinery an external landing needs** (behaviour-preserving; with `landing=local` the
board behaves exactly as recorded in P0.4).

- **P2a.1 — Extract `finalizeLandedIssue(workspaceId, mergeSha)`.** (L) One function both tail
  paths call, containing today's ordered steps. Guard the non-idempotent third behind a
  `finalized_at` marker persisted on **`workspace_merge_run`** — not on the PR row, because a
  `local` landing has no PR row and P4.1 routes it through this same function. The guarded steps: the dedicated verify session (`merge-workflow.ts:565`), `runLearningStep`,
  `autoStartFollowups`, `autoStartUnblockedDependencyIssue`, `createGithubHandoffDraft`, the
  OpenSpec apply-and-commit, and the cleanup at `merge-cleanup.service.ts:243-303`. The deferred
  `reset --hard` stays *outside* the function — it is local-landing-only by definition.
- **P2a.2 — The landing axis, in the existing config module.** (S) `shared/lib/merge-policy.ts`
  gains `resolveLandingMode(prefMap, projectId)` returning `local` or `remote_pr`, beside
  `resolveMergeStrategy(prefMap)`. It takes the extra `projectId` for the same reason
  `resolveMergePolicy(prefMap, projectId)` already does — landing is per project, strategy is not. It is **orthogonal** to `MergeStrategy`: one selects *where*, the other
  *who* (F7). Same per-project pref shape, same validated write path, no new config mechanism.
  Default `local`.
- **P2a.3 — Mode guards at all four base-advancing paths.** (M) `merge-executor.service.ts:101`,
  `merge-train.service.ts:183`, `done-unmerged-invariant-sweep.ts:435`,
  `worker-remote-sync.service.ts:63/:102`. Under `remote_pr` each **refuses and reports**; the
  sweep logs a finding instead of auto-merging; the merge-train path refuses outright (a train is
  N tickets in one landing and has no PR shape — §8). Behaviour under `local` is identical; the
  P0.3 ratchet is what makes a fifth path **loud** — not what proves there is no fifth path (§8).
- **P2a.4 — A non-terminal in-flight state.** (M) `awaiting-landing` in the workspace-status
  vocabulary (`workspace-liveness.ts`) — hyphenated to match the existing members, with
  `setWorkspaceStatus`'s terminal invariant taught that it is non-terminal, plus two additive
  `mergeState` buckets in `board-status-classifiers.ts`.

2a exits on its own gate before 2b starts — it is behaviour-preserving, so it can be verified
without any remote at all:

| 2a exit criterion | Phase-start value | What would turn it red |
|---|---|---|
| the P0.4 trace replays green after every item, `landing=local` | green | a reordering or a dropped step in the extraction |
| `finalizeLandedIssue` called twice with one `mergeSha` produces one of each side effect | function does not exist | any unguarded non-idempotent step |
| every base-advancing site carries a mode guard, and the P0.3 ratchet is green over the full verb list | 0 of 4 guarded | a fifth site, or a guard removed |
| `awaiting-landing` is accepted by `setWorkspaceStatus` as a non-terminal state and refused where a terminal one is required, and no existing status changes meaning | vocabulary without it | making it terminal, or reusing an existing member |
| `compare --history-ref <2a-start>`: summed CC of `merge-workflow.ts:452-619`, `merge-cleanup.service.ts:243-303` and `workspace-merge-cleanup.service.ts:85-146` **goes down**, and `workspace-merge.service.ts` does not go up | those three carry the tail today; 0.844 for `workspace-merge.service.ts` | extracting by *copying* rather than moving — which leaves the source CC unchanged |

**Entry gate to 2b**, operationally: the PR-triggered job set — today `check:arch`,
`openapi:check`, the docker smoke and the security scan, *not* the test suite — is green on **5
consecutive PRs produced by Phase 1's own publish path**, spanning at least 5 board tickets and at
least 3 days, with every run id recorded; one flake in those 5 resets the count. Five no-op PRs in
an hour do not satisfy it and would prove nothing about the signal Phase 2b gates merges on. Until
it is met the plan stops here, with the publish slice live and the machinery in place.

**2b — The remote becomes the place the merge happens.**

- **P2b.1** `ci-status` evidence minter in `merge-gate-evidence.ts`: read the PR head SHA's check
  runs; mint a `MergeGateToken` carrying `source:"ci"`, the run id and URL. Key it on the
  **pushed** SHA rather than the local worktree HEAD (`merge-gate-token.ts:61` reads
  `revParse(workspace.workingDir, ...)` today). The 15-minute age window is dropped for a
  SHA-pinned CI verdict — `contentMatch:127` already answers the question the window approximates —
  while the 3-hour persisted-reuse window stays. (M)
- **P2b.2** **The gate composes, it does not substitute.** Under `remote_pr` a merge requires the
  local tiered verdict **and** green checks on the pushed SHA (P0.1e). This is the honest reading
  of "CI has run green": on day one the CI half is `check:arch`, `openapi:check`, a docker smoke
  and a security scan — *not* the test suite. Saying so is the difference between a gate and a
  decoration. (S)
- **P2b.3** `startup/pr-landed-reconciler.ts`, a 30-second tick modelled on
  `auto-merge-orchestrator.ts`: for every open row in `workspace_pull_request`, poll state and
  checks; on `merged_at`, call `finalizeLandedIssue(workspaceId, mergeSha)`. This is also what
  makes a **human** merging on GitHub complete the item (D9). (M)
- **P2b.4** API merge with `merge_method:"merge"` once both evidence halves are present. (S)
- **P2b.5** Kill switch with drain: `landing=local` plus `kanban landing drain` — fetch, list the
  project's open board PRs, merge or close each, fast-forward the local base to `origin/<base>`,
  clear the marker rows. Without the drain, flipping back leaves PRs nobody will finalise and a
  local base behind origin that the reconcilers then act on. (S)

2b exit criteria (2a's gate above is a precondition):

| Criterion | Phase-start value | What would turn it red |
|---|---|---|
| **The demo**: one real ticket goes ticket, workspace, branch, PR, arch-gate green, **merged by the API**, `finalizeLandedIssue` observed (worktree gone, `mergedAt` set, issue Done, loop advanced) | Phase 1 merges locally and publishes the PR | any step needing a human hand |
| a PR merged **by a human** on GitHub finalises within one poll interval | not representable | the poller keying on its own merge only |
| with `landing=local`: the P0.4 trace replays green | green | remote logic leaking into the local path |
| `landing=remote_pr` with the invariant sweep enabled: **0** local auto-merges over 24 h, each open PR reported once as a finding | the sweep merges up to 3 per cycle | a missed guard (F1 again) |
| new *landing and CI-decision* logic lives only in `services/delivery/**` and `startup/pr-landed-reconciler.ts`; edits elsewhere limited to a declared allowlist — `merge-policy.ts`, `merge-gate-evidence.ts`, `merge-gate-token.ts`, the four guard sites, `workspace-liveness.ts`, `board-status-classifiers.ts`, `apiResponseSchemas.ts`, and the tail files the extraction touches | allowlist declared at phase start; 0 delivery files | **any production file not on the allowlist** gaining a landing branch |
| `compare --history-ref <phase-2-start>`: summed CC of `workspace-merge.service.ts` not up | risk **0.844** | putting the gate-composition logic there |

Risks, in order. (1) **The CI half is weak on day one** — arch, openapi, docker, security only; the
gate's strength still comes from the local run, and a reader could mistake "CI green" for "tested".
P0.1e and P2b.2 keep that visible. (2) **P2a.1 is the largest single item in the plan** and it
touches a 0.871-risk file; the P0.4 trace is the only thing standing between it and a silent
behaviour change. (3) **The asynchronous tail** — a merge the poller misses leaves a workspace in
`awaiting-landing` forever; the boot reconciler plus an age-based butler event are the backstop.
(4) Rate limits and poll cost, still unmeasured.

Do-not-build in Phase 2: no fast lane yet, no merge trains under `remote_pr`, no GitLab, no
webhooks, no settings-panel UI, no `board-events` payload channel.

### Phase 3 — CI becomes the gate of record

Goal: make the CI half strong enough that "CI green" means what a reader assumes, and route red
back to the agent. This is the phase that turns Phase 2's honest-but-weak gate into the goal.

- **P3.1 — The fast lane.** (M) A `pr-fast-lane` job in `arch-gate.yml` that runs the *scoped*
  suite. The board already computes the scope (`pre-merge-gate-tier.ts` producing
  `KANBAN_TEST_PACKAGES` / `KANBAN_TEST_FILES`) and the always-run guard set is *declared* by 166
  `@gate:always-run` markers that `scripts/test-mine.mjs` rediscovers. Pass the scope to CI in the
  PR body or a `.kanban/gate-scope.json` committed on the branch; the job runs the same
  `test-mine.mjs`. Target under 10 minutes.
- **P3.2 — Measure for two weeks** (minutes per PR, PRs per day, wall clock from PR open to merge,
  false-red rate) and **re-open `docs/decisions/016` with data**, as 016 itself invites: *"Re-open
  this only if the suite itself gets meaningfully faster ... not by re-measuring the same suite on
  a different runner class."* A scoped lane is a different suite, not a different runner. (S)
- **P3.3 — Only if the fast lane is green and under budget**: the local `verify_script` becomes
  *optional pre-push* under `remote_pr`, and the CI verdict alone mints the token. Until then it
  does not. (S)
- **P3.4 — CI red routes back** (D6): a red check on the PR head moves the workspace to `ci_red`,
  posts the failing job's log excerpt as the turn prompt, and reuses the existing
  `exit/fix-and-merge-exit.ts` path. A re-push updates the same PR. (M)
- **P3.5 — Reconcilers learn the remote**: `ancestor-branch-reconciler`, `hand-merged-*`,
  `silently-merged-*`, `base-branch-health-reconciler` compare against `origin/<base>` after an
  explicit fetch under `remote_pr`. (M)
- **P3.6 — Retire the single-box throttles for CI-sourced verdicts**: `machine-verify-lock`,
  `verify-chain-semaphore`, `jvm-build-semaphore` and the in-process `merge-gate-tree-memo` must
  not serialise or memoise a *wait*. (S)

Exit criteria:

| Criterion | Phase-start value | What would turn it red |
|---|---|---|
| fast-lane p50 wall clock at most 10 min, p95 at most 15 min over 20 or more PRs | **unmeasured**; the full local gate is 20-40 min (`workspace-merge-gate.ts:14`), the CI coverage job 24m39s (ADR 016) | scope leakage — the lane widening to the full suite |
| false-red rate at most 5 % over the same window | unmeasured | flaky suites entering the lane |
| a red check produces a fix turn on the same workspace and the *same* PR number | not representable | a new PR per fix |
| with `verify_script` optional: 0 merges landing a tree no CI run covered | not applicable | the token minting from a stale head SHA |
| ADR 016 carries a dated addendum with the measured numbers, either re-opened or reaffirmed | 016 as written | shipping P3.3 without it |

Do-not-build in Phase 3: GitLab, webhooks, merge trains, a second event system.

### Phase 4 — Decommission and harden

- **P4.1** `landing=local` **stays** a supported mode — the product is local-first and
  `docs/competitors/our-positioning.md` prices PR delivery at P3. What is decommissioned is the
  *duplication*: the local path's inline tail is deleted in favour of `finalizeLandedIssue`, and
  the four mode guards collapse to one because P4.2 has removed the extra landers. (M)
- **P4.2** `base-ref-advance-ratchet` tightened from 3 base-advancing merges to **1**
  (`merge-executor` only) by routing `merge-train.service.ts:183` and
  `done-unmerged-invariant-sweep.ts:435` through it. The 4 `branch -f` sites and the 2 non-base ref
  writes stay recorded and reasoned; tightening means the *base-advancing* count, not the whole
  vocabulary. (M)
- **P4.3** `analyze --fail-on-violations` added to `arch-gate.yml` against the declared
  `[architecture]` rules; scorecard targets **declared** in `.codemetricsrc` so the composite stops
  being advisory; `stakeholder-page` against the Phase-0 baseline. (S)

Exit criteria:

| Criterion | Phase-start value | What would turn it red |
|---|---|---|
| `base-ref-advance-ratchet` base-advancing count at **1** | 3 | any path re-added outside `merge-executor` |
| the depcruise `no-pr-client-outside-delivery` rule at `error` with 0 violations, and `analyze --fail-on-violations` green in `arch-gate.yml` against the declared `[architecture]` rules | rule at `error` since Phase 1; `[architecture]` not gated in CI | a violation, or the CI step being added `continue-on-error` |
| `compare <phase-0 baseline> <now> --history-ref 0610ecc174`: summed CC of `exit-workflow.ts`, `merge-workflow.ts`, `workspace-merge.service.ts` **below** their phase-0 values | 0.871 / 0.709 / 0.844 risk; CC pinned at phase 0 | deleting the duplication into a new file instead of out of these three |
| scorecard targets **declared** in `.codemetricsrc` (today `0 targets declared`, so the 88.8 composite is advisory) | 0 of 26 declared | declaring targets at the values already achieved |
| the team has run `landing=remote_pr` on at least one project for two sprints | 0 | reverting to `local` under load |

Note what is deliberately *not* an exit criterion: "these three files leave `refactor_first`". That
class is 336 files ranked by 180-day churn and author dominance, and this plan's own edits **raise**
their churn — it is not a thing the work can control, so the criteria gate summed CC instead.

## 6. What was verified, and how

Ten load-bearing claims — the ones where being wrong would change a phase, not just a sentence —
were attacked by the fixed method: exclusivity ("is this really the *only* place?"), counts
(re-derive, don't quote), absence (a grep is a grep), second-hand (a claim inherited from a prior
plan or a subagent is unverified until re-derived here), doc-endorsement (a doc saying it is so is
not evidence it is so). Verdicts: **6 confirmed, 1 weakened, 3 refuted or corrected.**

| # | Claim | Method | How it was checked | Verdict |
|---|---|---|---|---|
| **F1** | Landing is a branch at *the one* `merge-executor` call site (prior plan §7 finding 4) | exclusivity + second-hand | grepped every writer of `refs/heads/*`: `merge-executor.service.ts`, plus `merge-train.service.ts:183` (`mergeBranch(repoPath, trainRef, baseBranch)`), `done-unmerged-invariant-sweep.ts:435` (`await gitMerge(...)`, up to `MAX_AUTO_MERGES_PER_CYCLE = 3` per cycle), `worker-remote-sync.service.ts:63,:102` | **REFUTED.** Four paths, three bypassing the executor. Drives P2a.3 (guards at all four) and P0.3 (`base-ref-advance-ratchet`), which is the mechanical form of the answer. |
| **F2** | The merge gate runs once per merge, so a per-PR gate is a drop-in | exclusivity | `merge-train.service.ts:148-155` states in a comment that `landMergeTrain` "does NOT re-run the gate itself"; `merge-queue-train.ts:227` calls `runPreMergeGate` directly, a second lane | **CONFIRMED, with the consequence made explicit**: a train gates once for N tickets, which is not expressible as one PR. Phase 2 therefore has trains **refuse** under `remote_pr` rather than degrade silently. |
| **F3** | `status-write-ratchet.test.ts` protects the completion authority | absence | read `status-write-ratchet.test.ts:38-41`: `scanRoots` = `server/src`, `mcp-server/src`. `workflow-engine/transitions.ts:190,:244` live in `packages/shared` and write `statusId` + `statusChangedAt` | **CONFIRMED that the ratchet exists and CONFIRMED that it does not cover `shared`.** Drives P0.3's widening of `scanRoots` before any completion-state work. |
| **F4** | `board-events.ts` has 96 / 79 / 63 dependents (three prior sources, three numbers) | counts + second-hand | `graph --dependents-of` returned **10** direct dependents, 9 of them tests, against `--stats` transitive 580 for `schema/index.ts`. The gap is the engine's rule: **`import type` is not an edge**. Re-derived by grep: ~52 type-only importers, **7** value importers, 134 `.broadcast(` call sites, **3** subscriber registrations | **CORRECTED.** All three prior counts conflate three different things. The bus is an invalidation channel, not a domain-event bus; the plan does **not** schedule the `introduce_event` work and says so in §4 and §8. Also the reason no exit criterion in this plan is a raw `--dependents-of` count without a stated method. |
| **F5** | CI today is cheap enough that adding a required check is free | doc-endorsement, then measured | `arch-gate.yml`: `coverage` is `if: github.event_name != 'pull_request'`; `docs/decisions/016` records the coverage job at **24m39s** (run 32813234278) and a failing run at 15m34s, and rules coverage stays off `pull_request` | **CONFIRMED — and it is the reason Phase 2's gate composes rather than substitutes.** On day one "CI green" means *arch + openapi*, which is weaker than the local gate. The plan says so in the badge text, not only here. |
| **F6** | CI is green today, so a required check will not block work | absence | `BACKLOG.md` #834 is open: "confirm the Linux CI run is green after #828 — the fixes are unprovable on Windows by construction". No run status was fetched (offline; and reading CI would be a network call this plan does not take) | **WEAKENED — this is the one unknown that can invalidate Phase 2.** Made a **STOP-GATE** in P0.5: if master's own CI is not green, nothing in Phase 2 ships until it is. |
| **F7** | `MergeStrategy` is the natural place for a `landing` value | exclusivity | `merge-policy.ts:20`: `"direct" \| "monitor" \| "merge_queue"` — every value answers *who merges*, none answers *where the base ref lives*. Adding `"remote_pr"` would make `monitor`+PR inexpressible | **CONFIRMED that the file is right and the shape is wrong.** P2a.2 adds an **orthogonal** `resolveLandingMode` in the same file rather than a fourth strategy value. |
| **F8** | The repo has no PR machinery to reuse or collide with | absence (grep, stated as such) | grep across `packages/**` for `@octokit`, `pulls.create`, `gh pr `, `GITHUB_TOKEN`: **zero** non-test hits. The only remote-writing service is `worker-remote-sync.service.ts`. `CLAUDE.md:13` "PR creation skipped — manual merge only" and `:15` "`#N` always means a kanban issue number, never a GitHub PR" | **CONFIRMED as a grep, not as a metric** (the engine has no call channel). Consequence: Phase 2 is greenfield in `services/delivery/**`, and the `#N` collision is a naming constraint the branch prefix `dev/<who>/ak-<N>-<slug>` respects. |
| **F9** | "166 files carry `@gate:always-run`" (inherited figure) | counts + second-hand | one seam report said 154 after de-duplicating a scan that had recursed into `.claude/worktrees/`. Re-counted here directly: `grep -rl "@gate:always-run" --include=*.ts --include=*.tsx packages` → **166** files | **CORRECTED to 166, and the disagreement is the point**: any CI job that re-derives this set must scan `packages/` only, never the worktree tree, or the fast lane will silently run a different suite than the local gate. Noted in P3.1. |
| **F10** | The `workspaces` table cannot take a new column | doc-endorsement, then mechanical | `schema/workspaces.ts:7` says 38 columns and cites #739/#781/#798/#815; `workspaces-table-width-ratchet.test.ts` **enforces** it | **CONFIRMED, and mechanically enforced** — a doc claim backed by a test is evidence. Drives P1.2's separate `workspace_pull_request` table (three columns in Phase 1, the rest in Phase 2). |

Carried as **`unverified`** — used in the plan, not proven here:

- **The fast lane can reach 10 minutes.** No such job exists; the scope machinery
  (`pre-merge-gate-tier.ts`) does, and the 166-file always-run set is its floor. P3.1 builds it,
  P3.2 measures it, and P3.3 is *conditional on the measurement*. If the lane lands at 25 minutes
  the plan stops at Phase 2's composed gate — which is still the goal's core, just slower.
- **GitHub API rate limits and queue times for this org.** Not measured (offline). The
  `pr-landed-reconciler` is written as a poller with backoff for exactly this reason; if polling
  proves too costly, webhooks are the documented next step (§9).
- **That a human will accept the extra wait.** D8's exit criterion is behavioural, not mechanical.
  The kill switch in P2b exists because this one can only be answered by running it.

## 7. Adversarial review

One fresh generalist reviewer (full rubric R1-R8), round 1 on revision 1. Verdicts: **R1 WEAK ·
R2 PASS · R2b FAIL · R3 PASS · R4 WEAK · R5 PASS · R6 PASS · R7 WEAK.** Round 2 was **mandatory**,
because R8 forced a phase re-cut; it is recorded below the table.

| Finding | Fate | Where in the plan |
|---|---|---|
| **M1** The `base-ref-advance-ratchet` grammar covered only `mergeBranch` / `advanceRefWithCas` / `update-ref`, so `git branch -f` (4 non-test sites), `checkout -B` and `push`/`fetch` to `refs/heads/` were invisible — making "provably complete guards" false | **integrated** | P0.3 now defines the ratchet over the **ref-mutation vocabulary** and enumerates the four `branch -f` sites as known-safe with reasons; the Phase-0 and Phase-2 exit criteria restate the phase-start set (3 merges + 4 `branch -f` + 2 non-base) |
| **M2** Two risk scores were attached to the wrong files: `merge-train.service.ts` is **0.2817** (0.688 is `merge-queue.service.ts` #35) and `board-status-classifiers.ts` is **0.3427** (0.703 is `services/board-status.ts` #30) | **integrated** | §3 S1, S2 and S3 rows corrected; `merge-train.service.ts` re-classed **cold-on-seam**. Verified against `refactor_first.txt` and `analysis.json` |
| **M3** The Phase-1 `graph --dependents-of schema/index.ts` criterion could not fail — the change is additive and type-only importers are invisible (F4) | **integrated** | replaced by "`schema/index.ts` gains exactly one new export and its `--dependencies-of` count rises by exactly 1", plus the `error`-severity depcruise rule |
| **M4** A `warn`-severity depcruise rule cannot turn `pnpm check:arch` red, so the criterion "green with the new warn rule" was green by construction | **integrated** | the rule is added at `warn` in P0.3 only because the module does not exist yet, and is promoted to **`error` in the same commit that creates it** (P1.1); the criterion now reads "0 warnings and 0 errors, rule at `error`" |
| **M5** Phase 2's containment criterion ("all new production code under `services/delivery/**`") was contradicted by its own items, which edit cards, DTOs, evidence and classifiers | **integrated** | restated as an **allowlist**: new landing/CI-decision logic only in `services/delivery/**` and `startup/pr-landed-reconciler.ts`; edits elsewhere limited to eight named files, and any file not on the list turns it red |
| **M6** The checkout has **two** remotes — `origin` on a personal GitHub account and an internal `gitlab` — and the plan never said which one is the delivery remote, who owns it, or who pays for the Actions minutes | **integrated** (the decision) **+ shortcoming** (the answer) | new P0.1(g) makes it a Phase-0 decision with a named owner and a Phase-0 exit criterion; §9 **O6** carries the open question; §8 records that the plan cannot decide it |
| **M7** P0.1(b) keeps the token out of `kanban.db` but not out of the environment of the agents the board spawns — `agent.service.ts:542` passes "the full converged env", and `looksSecretEnvKey` only guards the *worker* path | **integrated** | new P0.1(f): the token is read at the delivery-service boundary and scrubbed from `spawnEnv`, asserted by a test in the `remote-spec-env` family — now a Phase-1 exit criterion, not an implicit hope |

**R8 — and the re-cut it forced.** The reviewer's one-phase alternative (publish-only, no mode
flag, no guards, badge from the existing `mergeState.bucket`, one kill switch) reaches a real PR
with real CI **in phase one**, where revision 1 reached it in Phase 2a behind an L-sized tail
extraction. That is earlier, so by the review's own rule the phase order was wrong. **The plan is
re-cut**: publishing is now Phase 1 and is purely additive; the extraction, the landing axis, the
mode guards and the in-flight state moved to Phase 2a, where they are first actually needed — the
merge only has to move once the *remote* is doing it. Nothing was dropped; the order changed and
Phase 1 shrank to what answers the open question (F6) soonest.

**Also fixed from the minor findings**: `CLAUDE.md:14` (not `:16`) for "Local only";
`worktree-ports.ts` is under `server/src/services/`; `git-receive-guard` governs **inbound**
worker pushes (`:24`, `:143`) so the `dev/` prefix is convention rather than enforcement; the
widened `status-write-ratchet` must also fix two stale/missing `AUTHORITY_FILES` entries; the
new state is spelled `awaiting-landing` to match the existing hyphenated vocabulary; exit criteria
now quote and gate on **risk scores and summed CC**, not on `refactor_first` ranks, which move with
other people's churn.


### Round 2 — scoped to the re-cut phases plus R7

Verdicts: **R1 WEAK · R2 PASS · R2b WEAK · R3 PASS · R4 WEAK · R5 PASS · R6 PASS · R7 WEAK.**

| Finding | Fate | Where in the plan |
|---|---|---|
| **M1** Publishing at the *end* of the tail is broken: `rebase.ts:86-88` says local `<base>` can be far ahead of a stale `origin/<base>`, so PR #1's diff would be every local-only commit, not the ticket — and by then `merge-executor.service.ts:236` has deleted the branch and the worktree is cleared | **integrated** — this is the round's plan-breaking finding | Phase 1 re-cut again: the publish point moved to **gate-pass (In Review)**, P1.1 fast-forwards the remote base *first*, P1.2 pushes the advanced base after the landing, and a new exit criterion requires PR #n's diff to be exactly ticket #N's commits with `origin/<base>` equal to local `<base>` at tail end. The base push is recorded in the P0.3 ratchet |
| **M2** Phase 1's coloured badge needs check-run state, obtainable only by polling — and the poller was P2b.3 | **integrated** | new **P1.4**, a read-only 60-second poller with no merge authority and no gate participation; Phase 2's `pr-landed-reconciler` becomes an extension of it rather than a new mechanism |
| **M3** The ref-mutation vocabulary was still incomplete — `reset --hard` (`merge.ts:477`), `rebase` (`rebase.ts:109,:194`), bare `execGit(["merge",…])`, `worktree add -b` (`worker-repo.ts:144`), `commit`, the injected alias at `done-unmerged-invariant-sweep.ts:121`, inbound `receive-pack`, and non-literal argv | **integrated** *(the definition)* **+ shortcoming** *(the limit)* | P0.3 now defines the ratchet over the **git verb list at the sanctioned spawn points**, with two companion assertions (the receive-guard prefix set unchanged; no non-literal argv). §8 states plainly that it is a **loudness device, not a proof**, and P2a.3's "proves the set is complete" was corrected |
| **M4** Phase 0's exit demanded CI *green*, contradicting P0.5's own "a red CI is a finding, not a failure" — and blocking Phase 1, the one phase that does not need CI green | **integrated** | Phase 0 exits on the colour being **recorded**; "green on 5 consecutive PR runs" became the **entry gate to Phase 2b**. P0.5 now says P0.1(g) must be decided before it can run, and Phase 0's do-not-build distinguishes product code from the manual no-op PR |
| **M5** The re-cut left Phase 2 as nine items including the only L behind a single exit gate | **integrated** | 2a and 2b are now **separately gated**: 2a has its own five-criterion table, verifiable with no remote at all, and 2b cannot start until 2a exits and the CI entry gate is met |
| **M6** `finalizeLandedIssue`'s `finalized_at` marker had no home under `landing=local`, where no PR row exists — yet P4.1 routes the local path through the same function | **integrated** | the marker moved to **`workspace_merge_run`**, the plan's own async precedent; P1.3 says so explicitly |

**R8 (round 2)** proposed publishing before the merge with a 60-second poller and no tail
extraction — which is what M1 and M2 already forced into Phase 1, so the shapes converged rather
than competing. The remaining difference is that the reviewer would also close the PR from the
local tail in phase one; the plan does that in P1.2 but leaves *how* (remote-side detection vs. an
explicit close) as a P0.1 sub-decision.

**Also fixed from round 2's minor findings**: §2's "everything that lands a merge is in the top 40"
was false and is now "the merge *drivers* are; the base-advancing *primitives* are not — which is
why F1 needed a grep"; `CLAUDE.md:14` "Local only" added as a sixth text P0.1 must narrow, with the
inbound/outbound distinction; `docs/prd.md:271` described as a future-work list, not a non-goal;
`merge.ts:477` (not `:474`) for the `reset --hard`; `resolveLandingMode`'s extra `projectId`
justified against `resolveMergePolicy`'s existing shape; `workspace_pull_request` created at its
full 13-column shape so Phase 2 needs no migration; a Phase-1 criterion added for the kill switch
actually stopping every push and API call.

**Round 3 followed**, narrow, on exactly those parts — the publish ordering and the 2a/2b gate
split. It is recorded below.


### Round 3 — narrow: the re-cut Phase 1, the 2a/2b gate split, and R7

Verdicts: **R1 PASS · R2 PASS · R2b WEAK · R3 PASS · R4 WEAK · R5 PASS · R6 PASS · R7 WEAK.**

| Finding | Fate | Where in the plan |
|---|---|---|
| **M1** "Fired at gate-pass" was itself an unenumerated exclusivity claim — the gate has six entry points (`exit-workflow.ts:434`, `workspace-merge-gate.ts:407`, `monitor-cycle.ts:470` and `:663`, `merge-queue-train.ts:227`, the in-lock re-gate at `pre-merge-gate.service.ts:715`), and `monitor-cycle.ts:470` lands an idle In-Review workspace that never had a review exit — so that whole live path would produce no PR | **integrated** | P1.1 is now one hook at the **`readyForMerge` arming write**, where all six converge, with the other five recorded as deliberately non-publishing; a Phase-1 exit criterion requires a `monitor-cycle`-landed ticket to have produced a PR too |
| **M2** The PR dies before CI can speak: `exit-workflow.ts:497` merges a foundational ticket synchronously, others within one 30-second tick, and pushing the advanced base lets the host close the PR as merged inside arch-gate's runtime — so the badge criterion was unreachable and Phase 1 bought a PR that lasts a minute | **integrated**, and it changed what the phase *is* | new **P1.5, the dwell**: with publishing on, the merge trigger waits for a terminal `ci_conclusion` or 20 minutes, then merges locally regardless of colour. The phase no longer claims "the board behaves exactly as today" — it says plainly that this is a behaviour change, and that testing whether the team can wait at all is the point |
| **M3** The base fast-forward publishes the entire local-only history to the delivery remote's default branch, unreviewed and un-CI'd, and has no defined behaviour when the remote base has *diverged* | **integrated** | P0.1(h): the remote's initial state and the explicit acceptance of bulk un-CI'd base advances until Phase 2, plus the note that branch protection on that base invalidates P1.2; a Phase-1 criterion requires the push to be fast-forward-only and to **refuse, report and open no PR** on divergence |
| **M4** Re-runs had no defined outcome — repeated gate passes, a deterministic branch name, and a PR already closed as merged | **integrated** | P1.3 gets a unique index on `(workspace_id)` for open rows plus `head_sha`; P1.2 states the four cases (refresh with force-with-lease / new branch suffix + new row / publish nothing / refuse), and P0.1(i) defines `<who>` |
| **M5** P0.4's trace covers the *tail*, but Phase 1 now modifies the **review-exit** sequence — a publish inserted before the `#629` committed-changes check would open an empty-diff PR and leave the trace green | **integrated** | P0.4 now records the review-exit ordering as well, and a Phase-1 criterion pins the publish call after the `#629` check and after `armReadyForMerge`, before any merge trigger |
| **M6** The 2a CC criterion was green by construction and named the wrong files — 2a does not touch `exit-workflow.ts`, and the extraction drains three other ranges | **integrated** | 2a now gates on summed CC of `merge-workflow.ts:452-619`, `merge-cleanup.service.ts:243-303` and `workspace-merge-cleanup.service.ts:85-146` **going down**, with `workspace-merge.service.ts` not going up |
| **M7** "Green on 5 consecutive PR runs" was not operationally defined — five no-op PRs in an hour would satisfy it | **integrated** | the 2b entry gate now names the job set, requires the 5 PRs to come from Phase 1's own publish path across at least 5 tickets and 3 days with run ids recorded, and resets on one flake |

**R8 (round 3)** put the dwell at the centre of the one phase rather than the badge — which is what
M2 forced into P1.5, so the shapes converged again. Its remaining difference is that it would drop
the badge's terminal-conclusion criterion; the plan keeps it, bounded by the recorded-timeout
escape.

**Also fixed from round 3's minor findings**: the `awaiting-landing` criterion read backwards and
now says accepted-as-non-terminal; Phase 2's header no longer claims 2a is gated on P0.5 (2a needs
no remote); P1.4's poll is capped per tick; the handoff-draft generation is stated to move to
publish and out of the tail; the kill-switch spy is scoped to the delivery module's own `fetch`;
`head_sha` is recorded at publish so 2b's minter need not re-derive it from a worktree that may be
gone; and Phase 1's risks name that `arch-gate.yml` triggers on `pull_request` into **`master`**
only — a different delivery base means no jobs and a permanently grey badge.

**Round 4 was not run, and that is a recorded shortcoming (§8).** Round 3's integrations changed
Phase 1 again — the arming-write hook and the dwell are new, and the dwell is a behaviour change on
a 0.871-risk file. By this plan's own rule a re-cut nobody has reviewed is not finished work. A
fourth round should be narrow and hunt exactly there: the arming write as the single publish point
(enumerate its writers the way F1 enumerated the landers), the dwell's interaction with the
orchestrator's backoff and the monitor's throttles, and whether the 20-minute timeout leaves a
workspace recoverable when the host is unreachable.

## 8. Known shortcomings of this plan

- **The board's event story stays a poller.** F4 killed the cheap version of the `introduce_event`
  prescription, and building a payload channel plus a subscriber registry on `board-events.ts` is
  its own project. So a PR that goes green at 03:00 is reflected on the board within one poll
  interval, not instantly, and the reconciler is one more scheduled job on a startup path that
  already has several. This is a deliberate trade, and it is the first thing to revisit if the
  latency is felt.
- **"CI green" is weaker than "the gate passed" for the whole of Phase 2**, by construction: ADR
  016 keeps coverage off `pull_request` and this plan does not overturn it without data (F5). The
  composed gate hides that from correctness but not from honesty — a reader seeing a green PR in
  Phase 2 is seeing arch + openapi, and the badge says so.
- **Trains are demoted, not ported.** Under `remote_pr` a merge train refuses (F2). Teams that
  rely on batching lose it until someone designs per-train PRs. No date is attached to that.
- **Four mode guards is three too many** and every one of them is a place a future path can forget
  to check. The ratchet makes forgetting *loud*, not impossible, and Phase 4 is what actually
  removes the duplication. Between Phase 1 and Phase 4 the guard set is the weakest part of the
  design.
- **The delivery remote is currently a personal account.** The plan can surface the decision
  (P0.1(g), O6) but cannot make it: who owns the repository, its Actions minutes and its bus
  factor is a team and budget question. Until it is answered, Phase 1 publishes into an individual's
  namespace, and the goal's "CI has run green" inherits that account's availability.
- **The ref-mutation ratchet is a loudness device, not a proof.** It reads source text at the
  sanctioned git spawn points, so it cannot see a non-literal argv, a `GitService` handed in as a
  typed constructor parameter, or an inbound `receive-pack` refname chosen by a worker (only
  `git-receive-guard`'s prefix set keeps that off `refs/heads`, and the ratchet asserts that set
  is unchanged rather than that it is sufficient). It makes a fifth lander loud; it does not make
  one impossible. Every "provably complete" reading of the guards should be downgraded to that.
- **Under `remote_pr` the board cannot land work offline.** `CLAUDE.md:14` "Local only" is narrowed
  by P0.1 to mean *no inbound service*, but an outbound dependency on a code host is still new: on
  a train, on a plane, or with the host down, a `remote_pr` project cannot complete a ticket. The
  answer the plan has is the kill switch plus `kanban landing drain` — a deliberate mode change,
  not a graceful degradation. Anyone who works offline routinely should stay on `landing=local`.
- **Phase 1 has been re-cut twice by review and the last re-cut has been reviewed by nobody.**
  Round 3's integrations added the arming-write publish hook and the dwell (P1.5), and the dwell is
  a behaviour change on `exit-workflow.ts`, the highest-risk file this plan touches (0.871). A
  fourth, narrow round is owed before Phase 1 is built: enumerate the writers of the
  `readyForMerge` arming state the way F1 enumerated the landers, check the dwell against the
  orchestrator's backoff and the monitor throttles, and check that the 20-minute timeout leaves a
  workspace recoverable when the host is unreachable.
- **No costs are promised.** The repo declares no per-finding effort model, so the S/M/L sizes are
  relative only; a phase-by-phase day count would be invented.
- **Windows/Linux asymmetry is inherited, not solved.** #834 exists because some fixes are
  unprovable on the dev box. Making CI the gate of record *improves* this, but Phase 0 cannot
  verify it from here — it can only stop the plan until someone looks.

## 9. Open decisions

| # | Decision | Options | Who / when |
|---|---|---|---|
| O1 | Poll or webhook for PR check status | poller with backoff (planned) vs. a webhook receiver, which needs an inbound URL and breaks "local only" (`CLAUDE.md:14`) | at P2b; revisit if polling cost is measured as real |
| O2 | Does `landing=remote_pr` become the default? | stays opt-in per project (planned) vs. default with `local` as escape | after Phase 3's two-week measurement |
| O3 | Whether ADR 016 is re-opened or reaffirmed | data-dependent by design (P3.2) | the ADR's own author, with P3.2's numbers |
| O4 | Merge method | `merge` commit (planned, keeps the existing ancestry reconcilers valid) vs. squash, which would invalidate `ancestor-branch-reconciler`'s assumptions | at P2b, and it is a one-line change with a large blast radius |
| O6 | Which remote is the delivery remote, who owns the account, who pays the Actions minutes | `origin` = a personal GitHub account (`p-wegner/agentic-kanban`) vs. the internal `gitlab` remote already in this checkout vs. an org-owned GitHub repo | **P0.1(g)** — before any code |
| O5 | Who owns the token | a single machine-scoped PAT (simplest) vs. per-developer credentials, which the team-capable plan wants for its own reasons | before P2a; it is a prerequisite, not a detail |

## 10. How to re-measure

```
code-metrics analyze . --days 180 --out <scratch>/out
code-metrics query <scratch>/out/analysis.json --summary --modules --class refactor_first
code-metrics graph <scratch>/out/analysis.json --dependents-of packages/shared/src/schema/index.ts
code-metrics baseline pin <scratch>/out/analysis.json          # at the start of Phase 0
code-metrics compare <baseline> <now> --history-ref 0610ecc174 # at every phase exit
```

Note the argument form: `query`/`graph` take the **`analysis.json` file**, not the output
directory. Pin the baseline before P0 and compare at every phase exit; `compare` refuses
incomparable snapshots, which is the point.
