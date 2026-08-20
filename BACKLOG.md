---
kanban-md: 1
project: agentic-kanban
exported: 2026-08-20T17:25:41.959Z
statuses: Backlog, Todo, In Progress, In Review, AI Reviewed
filter: status=open
issues: 20
---

# agentic-kanban — backlog

<!-- Backlog Markdown (kanban-md 1). One `##` per status column, one `###` per issue; the backtick line under a heading is its metadata. Edit freely and re-import — issues match by #number, then by title. Spec: docs/backlog-markdown.md -->

## Backlog

### #699 Ticket #697 worktree (ak-697) had all files vanish mid-session — first e2e fleet-dispatch run
`priority: high` · `type: task` · `created: 2026-08-20` · `updated: 2026-08-20`

Working ticket #697 (review the last 10 commits), running as this project's first end-to-end test of remote fleet dispatch. The worktree at C:\projects\andrena\.worktrees\agentic-kanban\ak-697 started the session with a normal-looking but already-incomplete checkout (README.md, node_modules, openspec, package.json, packages, pnpm-lock.yaml, pnpm-workspace.yaml, screenshot-script.mjs, scripts, test-setup, tsconfig.base.json, workshop — about 12 top-level entries), and was missing from the very start: .git (no repository at all — `git status` failed with "not a git repository"), .claude/, .codex/, CLAUDE.md, CLAUDE.local.md, .gitignore, and every other dotfile that a normal worktree has (compared directly against sibling worktree ak-674, which has all of them plus a proper `.git` file pointing at the shared gitdir).

Partway through the session (after roughly 10-15 minutes of work), the directory's remaining content disappeared entirely — `ls -la` and PowerShell `Get-ChildItem -Force` both now show the directory as completely empty (just `.` and `..`), verified independently via both Bash and PowerShell tools, so it is not a tool-specific view artifact.

Environment variables in this session show KANBAN_GIT_HTTP_HOST and KANBAN_FLEET_HOST both set to a Tailscale IP (100.105.24.76) rather than localhost, consistent with this being dispatched as a remote/fleet worker session rather than a normal local worktree.

Impact: the agent had no git repository to inspect and could not run `pnpm test:mine`, `pnpm typecheck`, or any other project command in its own worktree; it had to fall back to reading the main checkout at C:\projects\andrena\agentic-kanban read-only to do the actual review work. Any ticket requiring code changes and a commit would be un-completable in this environment as observed.

Suspected cause: either (a) the fleet/remote dispatch path materializes a worktree via some non-git copy mechanism that skips dotfiles (e.g. a copy/sync step without hidden-file support) and never actually performs a git clone, or (b) a cleanup/GC process on the host swept the worktree while the session was still using it. Given decision 012's git-smart-HTTP transport design (worker clones over HTTP, pushes to refs/kanban/incoming/*), the complete absence of .git even at session start suggests the clone step for this workspace did not run as designed, or the workspace was pointed at a directory that was never actually populated by it.

Recommended next step: check server-side worktree creation / fleet placement logs for workspace ak-697 (issue #697) to see what actually populated this directory, and whether the assignment ever completed a real git clone.

### #701 POST /api/workspaces (and CLI `workspace start`) takes only an issue UUID, not #N
`priority: d1c5d9c1-4897-4e1b-acc3-2aa96de04117` · `type: task` · `created: 2026-08-20` · `updated: 2026-08-20`

The one call that actually starts work — POST /api/workspaces — requires `issueId` (a UUID) and rejects an issue number (routes/workspaces.ts:131). The CLI verb `workspace start <issue-id>` passes it straight through, so it inherits the same restriction.

### #681 verification: nothing alarms on a degenerate signal or a guard suite red for days
`priority: high` · `type: task` · `tags: verification, observability` · `created: 2026-08-20` · `updated: 2026-08-20`

Two measured rot windows that no mechanism reported:

**A degenerate distribution went unnoticed for 5 days.** `base_branch_health` for this project: **200 probes, 199 red + 1 timeout, 0 green, ever** (2026-08-16 → 08-20). Fleet-wide 2079 red / 1876 green, with reds that are unmistakable install artifacts (`TS2688 Cannot find type definition file for 'node'`, `Could not resolve 'vite'`). Roughly half of all recorded base-health verdicts in the DB are false. Cause fixed under #674; **the missing alarm is not**: no check asks "has this probe ever been green?".

**Guard suites rotted for weeks while every commit message claimed green.** Breakage age at repair (`7e4dad1f1b`): `console-tag-ratchet` **~26 days**; `codex-skills-parity` up to 60 h; `container-reap-terminal-paths` broken **58 minutes earlier** by `84b684d3a2` (#549) — that commit's own author did not run the always-run set. The #614 time-spelling ratchet landed already red in `f85eb2e1f5`, was fixed, went red again for **47.9 h / 144 commits**.

Fix: alarm on a degenerate verdict distribution (N probes, 0 green) and on any `@gate:always-run` suite red for more than one cycle.

- [ ] degenerate-distribution alarm on base-health
- [ ] always-run suite red-for-N-cycles alarm

### #682 data: slugify consolidation silently relocates persisted artifact paths (diacritics + cap trim), with no migration
`priority: high` · `type: bug` · `tags: data-compat, slugify` · `created: 2026-08-20` · `updated: 2026-08-20`

`b329b80ddd` is a genuine consolidation (nine implementations → one rule with exactly two options), but two of the collapsed sites write **persisted on-disk paths**, and the new rule changes them:

- `packages/server/src/services/phase-artifacts.service.ts:35` (`{maxLength:60, fallback:"issue"}`) feeds `specs/${issuePart}-${issueSlug(title)}/${fileName}`. Measured old→new: `"Über-Ticket"` → `ber-ticket` → `uber-ticket`; `"Straße"` → `stra-e` → `strasse`.
- `packages/shared/src/lib/drive-retro.ts:74` produces `docs/board-runs/<slug>.md` — a project with an umlaut now writes to a different file and its accumulated retro history stays in the old one. Split history, silently.

Not only diacritics: the cap-trim change diverges on pure ASCII too — a slug that hits `maxLength` mid-run lost its trailing dash (`…uvw-` → `…uvw`), so those directories move as well.

This board is used with German ticket titles, so it is not hypothetical. The commit frames diacritic folding as a pure improvement and never states it is a data-compat break. No migration, no test, no note.

Also from the same commit (narrower, upgrade-window only): `workflow-fork.service.ts:117` `childBranchName` changed in three ways at once, and all three call sites (`:135`, `:236`, `:371`) **re-derive** rather than reading the persisted row — a fork queued before the commit and started after gets a worktree on one branch while its DB row names another.

- [ ] migrate or alias existing artifact/retro paths
- [ ] `childBranchName` read from the persisted row, not re-derived

### #685 installs: a `pending`/`running` install state is unreclaimable and invisible
`priority: high` · `type: bug` · `tags: installs, merge` · `created: 2026-08-20` · `updated: 2026-08-20`

There is no timeout, no reconciler and no re-run path. `install_state` is written only in `workspace-repos.service.ts:240/244/247` + `repo.repository.ts:174` and read only by the gate and the status services. `installUpdatedAt` is written (`repo.repository.ts:238`) and **never read anywhere** — the very column a staleness reconciler would need.

The row is written in the create transaction (`workspace-repos.service.ts:427`) while the runner starts far later in the deferred step (`workspace-create.service.ts:547`), so ordinary events leave `pending` rows forever:
1. blocking leading setup failed (`workspace-create.service.ts:851-861`) skips `scheduleDeferredProvisionAndLaunch` entirely — then `born-blocked-reconciler.ts` re-runs only the LEADING setup and releases the workspace to `idle`, giving a launchable workspace whose merge is permanently refused;
2. server restart / crash mid-install;
3. any deferred-step early return before `:547` (workspace deleted/closed, terminal status, a throw in stack provisioning).

No recovery exists: `workspace resume` / `POST /workspaces/:id/launch` only relaunch the agent; `provisionSiblingWorktrees` / `runBackgroundSiblingInstalls` have one caller each. The only exits are recreating the workspace or hand-editing the DB.

Aggravating: the withhold is tagged `pre_merge_gate_failed`, which by design stays out of every agent retry path and dedupes the timeline note, so the monitor re-withholds every cycle in near-silence. And **nothing renders it** — zero consumers of `installState`/`installSummary` in `packages/client/src`, so the "installing 3/16" chip does not exist; the operator's only signal is the gate refusal text.

- [ ] staleness reconciler using `installUpdatedAt`
- [ ] a re-run path that does not require recreating the workspace
- [ ] surface install state in the UI

### #688 tests: no line-coverage measurement exists, and 28% of the wave's new code is referenced by no test
`priority: medium` · `type: task` · `tags: tests, coverage` · `created: 2026-08-20` · `updated: 2026-08-20`

**Coverage is unmeasured and not runnable without adding a dependency**: zero `coverage` entries in any `package.json` or `vitest.config.ts`, `@vitest/coverage-v8` not installed, no `lcov`/`coverage-summary.json`, no coverage step in the three CI workflows. (The `coverage-intelligence` skill is behavioural prose, not line coverage.)

Proxy measurement over the wave: **81 new production files, 7,821 LOC in 3 days; 23 files / 2,179 LOC (28%) referenced by no test** (symbol-verified against the whole test corpus). Largest untested first:

| LOC | File | Untested exports |
|---|---|---|
| 283 | `client/src/components/BacklogMarkdownModal.tsx` | 1/1 |
| 276 | `server/src/services/workspace-launch-preview.service.ts` | `createLaunchPreviewService` |
| 248 | `shared/src/lib/board-events-contract.ts` | 11/11 |
| 223 | `server/src/services/project-worktrees.service.ts` | `createProjectWorktreesService` |
| 207 | `server/src/services/ticket-group-scan.service.ts` | `scanForTicketGroups`, `applyTicketGroupProposals` (#661) |
| 115 | `server/src/routes/issue-body-schemas.ts` | 11/11 request validators |
| 100 | `shared/src/lib/plugin-placeholders.ts` | 2/2 |
| 64 | `shared/src/lib/issue-vocab.ts` | 7/7 |
| 58 | `mcp-server/src/board-call.ts` | 3/3 |
| 39 | `shared/src/lib/issue-ref.ts` | `parseIssueRef`, `isNumericIssueRef` — the exact "never regex a bare `#N`" hazard |

- [ ] coverage measurable with one command
- [ ] tests for the request validators and `issue-ref`

### #689 honesty: the PassReport payload is write-only, and was applied to the 5 passes that did not have the problem
`priority: medium` · `type: chore` · `tags: dead-code, observability` · `created: 2026-08-20` · `updated: 2026-08-20`

`6514b5ba0a` added +239/−24 LOC whose entire payload has no reader. No consumer of `PassReport.acted` / `.skipped` / `.reasons` exists outside `packages/server/src/lib/pass-report.ts` and its own test; `formatPassReport` and `passReasonCounts` (`:64`, `:71`) are referenced only from `pass-report.test.ts`.

The stated payoff — "a pass that swallowed failures cannot read as a clean run" — is delivered only by `formatPassReport`'s `N unaccounted` tail, which is never printed. Four of the five adopters discard the report entirely (`born-blocked-reconciler.ts:237`, `workflow-node-divergence-reconciler.ts:192`, `startup-tasks.ts:855`, `:910`). All 18 `recordActed`/`recordSkipped` calls are dead bookkeeping. Net operator-visible change: zero.

And the abstraction went to the wrong passes: the commit's diagnosis is that passes "return a bare `number` or `void`", yet all five adopters **already returned a structured result**. Not one bare-`number`/`void` pass was migrated — ~24 remain, incl. `plan-mode-reconciler.ts:60`, `stranded-review-reconciler.ts:112`, `zombie-fix-session-reconciler.ts:49`, `ancestor-branch-reconciler.ts:105`, `silently-merged-reconciler.ts:29`, `base-branch-health-reconciler.ts:29`.

- [ ] either print the report or delete the payload
- [ ] if kept, migrate the passes that actually have the defect

### #690 env/ports: three board-port ladders survive the "one resolver" claim, and the client-port ladder is unguarded
`priority: medium` · `type: chore` · `tags: env, ports` · `created: 2026-08-20` · `updated: 2026-08-20`

The guard (`board-port-ladder-single-source.test.ts`) is genuinely good — allowlist of 3, reverse ratchet, red on revert — but its regex only sees `KANBAN_SERVER_PORT`, so three live board-port ladders spelled without it survive and honour **none** of the vars:
`packages/server/src/cli/index.ts:160` `Number(process.env.PORT || 3001)`, `cli/commands/system.ts:144`, `server-start.ts:173`. ~24 CLI help strings still advertise `"default: $KANBAN_SERVER_PORT or 3001"` for a flag whose default ignores it.

"One resolver" is actually four for the same concept, differing in rungs: `resolveBoardServerPort`, `runtime-port.ts:9 resolveRuntimeServerPort`, `runtime-port.ts:33 resolvePublicBoardUrl`, `scripts/server-dev-proxy.mjs`. Only the last pair is checked for agreement.

The **client**-port ladder was left entirely undrained and unguarded — `KANBAN_CLIENT_PORT || VITE_PORT || "5173"` verbatim in `lib/agent-launch-env.ts:50`, `services/review.service.ts:158`, `startup/merge-workflow.ts:426`.

Env registry: all 7 registered names are cleanly migrated, but **84 bare `process.env.<NAME>` reads across 32 files / 42 distinct names (21 `KANBAN_*`) remain and nothing forbids one** — the only enforcing test is a closed loop over the 7 already-migrated vars. `docs/env-vars.md:1` still claims it documents "every" environment variable.

- [ ] the three surviving ladders use the resolver
- [ ] guard the client-port ladder
- [ ] correct the `docs/env-vars.md` scope claim

### #691 process: declared "batch 1" refactors have no disclosure channel, so the remainder is invisible
`priority: medium` · `type: task` · `tags: process, docs` · `created: 2026-08-20` · `updated: 2026-08-20`

The repo has **no `CONTINUE.md` and no `BACKLOG.md`**, and `docs/state.md` has zero hits for `569`, `591`, `612`. So a self-declared partial refactor has nowhere to record its remainder, and three did:

- **#569 wire-DTO** (`c0bba1eef1`): batch 1 removed 13 of 74 duplicates (17.6%); **61 remain — 82% of the job**. No batch 2/3 commit exists; the ticket is Done with zero comments and its description closes the trail ("the rest is a mechanical follow-up the guard tracks"). The docstring also states two different totals (90 vs 75).
- **#591 one ExecResult shape** (`80189f31af`): structurally sound and typecheck-clean, but `execSucceeded` and `execFailedToRun` have **0 non-test callers** while **42** hand-rolled `.code === 0 / !== 0 / === null` checks remain — including `workspace-services.service.ts:231,250,261,275`, which write `res.code === 0` on the very lines that call `execErrorMessage(res)`.
- **#513 ratchet**: message says "35 ladders remain"; **83 remain** across 121 call sites — understated 2.4×.

Fix: adopt the `CONTINUE.md` / `BACKLOG.md` convention, or require a follow-up ticket whenever a commit declares itself batch 1 of N.

- [ ] a disclosure channel exists for declared partial work
- [ ] follow-up tickets for the #569 and #591 remainders

### #693 cli: 6,620 LOC whose only tests are gate-excluded, and zero coverage of any converted handler
`priority: medium` · `type: task` · `tags: cli, tests` · `created: 2026-08-20` · `updated: 2026-08-20`

`b10195036c` (#505) is the cleanest commit of the consolidation wave — `cliAction` takes one parameter, no flag soup, and the mechanical claims verify exactly (75 `runMigrations` handlers, 65 converted, 10 accounted-for stragglers; no migration added; no exit code or bespoke message flattened). But:

- there is **no `packages/server/src/cli/__tests__/` directory**; `grep cliAction` across all `*.test.ts` → **no matches**. The new abstraction has no test at all — not the error path, not the exit code, not the migration call.
- `packages/server/src/cli/` is 6,620 LOC whose only tests (`cli.test.ts`, 51 tests) are in the `test:mine` exclusion list, so the CLI is ungated at every tier.
- `resolveIssueArg` / `resolveIssueNumberArg` have no test either — and they carry the one genuine **behavior change** in that commit: `issue update` and `issue move` were rewired (that is #509 work riding along), so a miss on a numeric ref now prints the #467 cross-project explanation instead of `Issue '42' not found.` The commit discloses adding the helper, not rewiring the two call sites.

- [ ] tests for `cliAction` and `resolveIssueArg`
- [ ] the CLI is covered at some gate tier

### #695 arch: a second stack-marker ladder survives the detector consolidation, and nothing prevents a third
`priority: medium` · `type: chore` · `tags: arch, stack-detection` · `created: 2026-08-20` · `updated: 2026-08-20`

`9b79937d13` genuinely collapsed a 9-branch ladder to `deriveVerifyCommand(detectStackProfile(...))` plus 3 documented gap branches, and broke the import cycle by extracting `services/stack-markers.ts`. Remaining:

- **a genuine second marker ladder, never mentioned**: `packages/shared/src/lib/container-dep-volumes.ts:47-53` (`MARKER_DEP_DIRS`) + `:84` `existsSync(join(worktreePath, entry.marker))` — different output (dep dirs, not commands), same "existsSync marker ladder outside the canonical detector" shape.
- **no scanner prevents a third.** No test references `PROJECT_MARKER_FILES` or asserts a single detection source; `check:arch` covers god-modules, lint:arch and MCP catalog parity. Adding a new ladder today fails nothing — unlike the pattern the repo uses elsewhere (`git-exec-single-spawn.test.ts`, `board-port-ladder-single-source.test.ts`).
- the new profile-first path in `project.service.ts:807-820` / `:836-850` has **zero** test coverage.
- dead shim: `isUvProject` re-exported from `project-setup.service.ts:12` has 0 consumers.

- [ ] single-source guard for marker detection
- [ ] tests for the profile-first setup/verify derivation

## Todo

### #700 Decompose exit-workflow.ts back under the god-module ceiling (1048 > 1000)
`priority: medium` · `type: task` · `created: 2026-08-20` · `updated: 2026-08-20`

PR #7 (integrate/fork-workflow-996-1003) was merged knowing it breaches the repo's own god-module gate. This ticket is the agreed follow-up; it was a deliberate decision, not an oversight.

#### What is breached

- `exit-workflow.ts` is 1048 lines against the 1000-line hard ceiling in `scripts/check-god-modules.mjs` (MAX_LINES = 1000).
- 2 modules declare more than 20 top-level functions/classes (the low-cohesion smell, #889).

Before #7, master breached neither. The `arch-gate` workflow was already red, but only from an unrelated infra failure (`No such built-in module: node:sqlite` in mcp-catalog-parity.test.ts). **That matters: the gate is now red for two different reasons at once, and the next person cannot tell them apart from the summary.** Fixing this one restores that signal.

#### Why it was merged anyway

The file grew by unioning both sides of a 1319-commit upstream integration. Decomposing during that merge would have made a 31-commit integration unreviewable as a merge, which was the greater risk.

#### Shape of the work

The PR body names two cohesive extraction candidates. Take those first and re-run `node scripts/check-god-modules.mjs` — it prints the offenders and the ceiling.

#### Related, deliberately left alone

`exit-workflow.ts` now carries TWO stacked guards: upstream's narrow `isSpecPlanningNode` and #997's broad `isWorkspaceOnNonTerminalWorkflowNode`. Both were kept on purpose — they fire at different points in `handleBuilderSessionExit`, and dropping the narrow one changes the learning-step and auto-land paths. Reviewed and judged correct for the merge: an integration should not silently change behaviour on those paths. Whether the narrow guard should eventually be subsumed by the broad one is a SEPARATE question needing its own test evidence. Do not fold it into this decomposition.

## In Progress

### #675 gate: a docs-only diff skips the `@gate:always-run` suites whose input IS markdown
`priority: critical` · `type: bug` · `tags: gate, verification` · `created: 2026-08-20` · `updated: 2026-08-20`

The docs-only skip sits UPSTREAM of the always-run mechanism, so suites explicitly marked
"must run even when the gate scopes" are not run at all — and the gate reports
`pre-merge gate skipped — docs-only diff` as a PASS.

- Predicate: `packages/shared/src/lib/docs-only-diff.ts:17` — `DOCS_ONLY_EXTENSIONS = /\.(md|mdx|rst|adoc)$/i` matches ANY `.md` path anywhere.
- Skip sites: `packages/server/src/services/pre-merge-gate.service.ts:417` (`docsOnly`), consumed at `:424` (skips `verify_script`) and `:647` (skips the smoke/boot check). E2E lane too (`e2e-smoke-lane.ts:134`).
- 16 `@gate:always-run` suites take markdown as their assertion input, incl. `claude-md-skill-and-feedback-invariants.test.ts` (reads `CLAUDE.md`), `env-registry-doc-parity.test.ts` (reads `docs/env-vars.md`), `codex-skills-parity.test.ts` (compares `.claude/skills/**` vs `.codex/skills/**`), `roast-skill.test.ts` / `board-monitor-skill.test.ts` (`readFileSync` on `SKILL.md` at module load).

**It already fired.** `cc604e914f` changed only `.claude/skills/direct-master/SKILL.md`; `36b18f5dac` only the two `SKILL.md` copies. Eight hours later `7e4dad1f1b` had to repair six always-run suites, reporting that "the committed .codex copies of backlog-refill/direct-master had drifted from their .claude sources" — a markdown-only branch merged green and left master red on the guard that exists to catch exactly that drift.

`fix(#642)` hardened the *extension set* under `docs/` but never questioned the premise the commit states outright. The false premise is "a `.md` change cannot break the build" — in this repo it is false by construction.

Fix: the docs-only skip must not skip the always-run set. Either run `ALWAYS_RUN_TESTS` even when `docsOnly`, or make the predicate false whenever a changed markdown path is an assertion input of a marked suite.

#### Steps
1. run the always-run suites on a docs-only diff instead of skipping the gate wholesale
2. cover it: a `CLAUDE.md`-only and a one-sided `SKILL.md` diff must both fail the gate when they break a guard

- [ ] always-run set runs on a docs-only diff
- [ ] regression test for the `SKILL.md` one-sided-drift case

### #679 gate: 17 suites / ~298 tests are excluded from `test:mine`, which IS the gate's test half
`priority: high` · `type: task` · `tags: gate, tests` · `created: 2026-08-20` · `updated: 2026-08-20`

`scripts/test-mine.mjs:97-132` — 17 exclusions, 298-319 `it()`s (~3.7% of 8171) across ~9,139 LOC.

**The damning commit is `ae6de9b34d` (2026-07-24)** — `fix(#173): default the node verify gate to quickTestCommand, not the full suite` — the same commit that pointed the verify gate at `test:mine` added 12 of the 17 exclusions. The gate was made cheap and simultaneously blinded to the suites guarding what it protects.

Six have **no environmental excuse** (in-memory SQLite + injected `gitService` + `helpers/temp-repo.ts`, which never spawns git): `workspace-merge-service` (42 tests), `done-unmerged-invariant-sweep` (37), `preferences` (22), `workspace-lifecycle-transitions` (14), `merge-service-edge-cases` (12), `merge-endpoint-reconcile-noop` (8). Measured 56/56 green in 202 s, of which 129 s is module import — the #278 fork-transform problem, not the #173 real-git problem they are filed under.

What passes the gate today: re-breaking conflict-marker spillover (#598-600), reintroducing the 0-commit false-positive Done, breaking merge-retry idempotency, breaking `resolveMergeState`'s decision table — each already shipped once as a bug and each covered by a test that does not run.

Compounding: nothing in the repo runs `pnpm test:full` (no CI test job), and `packages/e2e/playwright.config.ts:71` `grepInvert: /@system/` removes 67 E2E tests across 11 files (workspaces/worktrees/ready-for-merge/diff-viewer/merge UI). The merge path is unverified in both the unit gate and the default E2E lane.

- [ ] readmit the six suites with no environmental excuse (fix the import cost, not the coverage)
- [ ] a lane that actually runs `test:full` and the `@system` E2E tests

### #680 gate: guard suites are not hermetic, so the gate cannot tell a regression from load
`priority: high` · `type: bug` · `tags: gate, flaky` · `created: 2026-08-20` · `updated: 2026-08-20`

Measured on master (`7a63062737`), full `pnpm test:mine`, 16 CPU / 30 GB, ~33 min:
**10 suites / 10 tests failed, exit 1 — and every one passes in isolation.** Zero confirmed code regressions; a 100% load-dependent red.

Failures: `verify-gate-runner`, `merge-overlap-cluster-landing` (timeout 60 s, suite took 259 s), `workspace-merge-multirepo-retry` (120 s / 306 s), `workspace-repos-merge`, `git-prepare-for-review` (2/2), `ancestor-branch-reconciler`, `session-lifecycle:549` (`expected 1 to be >= 2`), `repo-lock-unavailable-fails-fast:82` (failed in 192 ms — a timing race), `get-context-boundary` (suite timeout), and `client-conventions-guard.test.ts:130` — **a `@gate:always-run` guard suite**.

Worse: a subagent independently observed an untracked `packages/shared/__tests__/zz-adversarial-tmp.test.ts` transiently present — **some suite writes a temp test file into a real `__tests__` directory**, which is why a repo-scanning ratchet sees a different tree under parallelism.

`b4b9963911` (#620) shows this is chronic: 33 hand-set 30 s budgets below the shared 90 s `GIT_HEAVY_TEST_TIMEOUT_MS`, acknowledged by #206 and never migrated.

**A gate whose red is usually noise trains its operators to ignore red — which is what happened during the wave.**

- [ ] no suite writes into a real `__tests__` dir
- [ ] repo-scanning guards are hermetic under parallelism
- [ ] migrate the sub-90s git-heavy timeouts

## In Review

### #672 Session transcript loses the assistant/result lines when an agent exits fast
`priority: medium` · `type: task` · `created: 2026-08-20` · `updated: 2026-08-20`

GET /api/sessions/:id/output returned only TWO events for a session that ran fine: one batched stdout chunk holding the four SessionStart hook lines, then exit code 0. The raw stream file (os.tmpdir()/kanban-session-<id>.out, 13KB) held the whole run including the assistant text and the final result line. So an operator looking at the transcript of a SUCCESSFUL run sees hook noise and nothing else.

Repro (2026-08-20, session 2baa30a5-172e-446b-b970-6cc0fb0f8d13, workspace 9afbc406-4d62-48aa-8c72-41aeb4864206 / issue #671): POST /api/workspaces/:id/turn with a one-line prompt ('reply PONG and stop'). The agent answered PONG, result subtype=success, exit 0 within ~20s. session_messages carries neither the assistant nor the result line.

This looks like the same shape as the #909 exit-before-output-drain race, but on the PERSIST side rather than the classify side: the 500ms output-file watcher batches, the process exits almost immediately after the last write, and drainNow()'s content does not reach session_messages. Worth checking whether drainNow() feeds broadcast() (which does the fire-and-forget insert) or only the classifier.

Why it matters beyond cosmetics: hadSubstantiveOutput-style reasoning and every human triage of 'did this agent do anything?' reads the persisted transcript. A fast, successful run that looks empty is exactly the signature the board otherwise treats as a launch failure.

Found while fixing the ACP-env agent-spawn hang (board commit 24ab25a9ac).

CORRECTION TO THIS TICKET'S PREMISE (from the filer): the transcript is NOT lost. Re-querying GET /api/sessions/2baa30a5.../output later shows the assistant AND result lines present — inside the SAME two events. They are batched into one large stdout blob, and when I filed this I read only a truncated slice of that blob and wrongly concluded they were never persisted. What actually happened is that the tail arrived AFTER the exit event, which is precisely the race the fix on this branch describes. So: server-side persistence is fine, the defect is a UI one (the panel stops polling on the running->ended edge and has no later trigger), and the client-side trailing refetch is the right layer to fix it. The #909 drain machinery is not implicated.

### #673 Two workspaces can be created for one issue, sharing one worktree dir — both launch agents into it
`priority: high` · `type: task` · `created: 2026-08-20` · `updated: 2026-08-20`

Issue #670 held TWO open workspace records, created 9 seconds apart (a15a0c0d 05:59:39, eeb49339 05:59:48), on the SAME branch (feature/ak-670-architecture-improvement-code-metrics-ru) with the SAME workingDir (.worktrees/agentic-kanban/ak-670). The monitor relaunched both, so two agents ran concurrently in one working directory on the same branch Ã¢â‚¬â€� double quota spend on identical work, and whatever they wrote raced.

Second defect found while cleaning it up: the workingDir both records carried was NOT a registered git worktree. `git worktree list` had only `ak-670-2` on that branch; `ak-670` was a leftover directory. So the creation path had fallen back to a `-2` suffix at some point without the DB records following, which is the most likely explanation for the repeated 'blocking setup script failed for workspace eeb49339 (exit 1)' Ã¢â‚¬â€� pnpm install -r was running in a dir that was not the worktree. `DELETE /:id/stale-worktree` then failed with EBUSY because a stopped agent still held the leftover dir.

Wanted:
1. Creating a workspace for an issue that already has an OPEN workspace on that branch should refuse (or attach to it), not mint a second record. There is no legitimate reading of two live workspaces sharing one worktree.
2. When the worktree path is suffixed (-2, -3) because the preferred dir is occupied, the DB record must carry the ACTUAL path. A record whose workingDir is not in `git worktree list` should be a loud reconcile, not a silent setup failure.
3. Closing one of two workspaces that share a workingDir must not delete the dir under the other (it did not here only because cleanup hit EBUSY).

Repro artifacts: both records were closed and one fresh workspace (23744458) was created on the real worktree ak-670-2, which launched correctly. Leftover .worktrees/agentic-kanban/ak-670 was still on disk at the time of filing.

RACE CONFIRMED (same day, 10:48): after closing the first pair I created ONE workspace explicitly (23744458, 10:48:34) â€” and the MONITOR auto-started its own for the same issue 8 seconds earlier (a1e70a35, 10:48:26). Both landed on worktree ak-670-2 and both ran agents in it. So this is not a one-off from a stale record: there is no uniqueness guard at all between the monitor auto-start path and POST /api/workspaces, and a concurrent create wins twice. Mitigated by hand with the no-auto-start tag on #670 plus stopping the later session, which is not a fix â€” the guard has to live in the creation path (an issue with an OPEN workspace on that branch must refuse or attach), and it has to be a transaction, not a check-then-insert.

MITIGATION GAP (worth its own line): the no-auto-start tag does NOT stop a RELAUNCH. After tagging #670 and stopping the duplicate session, the monitor relaunched that same duplicate workspace twice within four minutes ('Relaunched idle workspace 23744458'), so the tag gates auto-START of new work only. There is therefore no operator lever that quiets an already-duplicated workspace short of closing it — and closing one of two workspaces sharing a worktree is the very thing item 3 above says is unsafe. Resolution used in the end: close BOTH and create one, which works only because the tag prevents the auto-start half of the race from re-firing.

### #674 Base-branch health probe never installs the clone, so master is permanently reported RED and every merge is withheld
`priority: high` · `type: task` · `created: 2026-08-20` · `updated: 2026-08-20`

verifyBaseBranchHealth (services/base-branch-health.service.ts) clones the base branch into a fresh temp dir and runs verify_script there. Its header says this is deliberate â€” 'no warm deps, no junctioned node_modules'. But it never runs the project's setup_script (or any install/build) in that clone, and this repo's shared package is only usable after a build: packages/shared/package.json has prepare -> pnpm build -> tsc, i.e. dist/ is produced by install, and it is NOT in git.

So the probe measures a checkout that cannot pass. Recorded result for this project (base_branch_health, sha 4bb787fc32, 98020ms, 2026-08-20T11:40:06Z):

  <tmp>/kanban-base-health-<projectId>-master/packages/mcp-server:
   ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command failed with exit code 1: vitest run src/__tests__/mcp-catalog-parity.test.ts

mcp-catalog-parity.test.ts imports @agentic-kanban/shared/lib, which resolves to shared's dist under a plain vitest run. No install in the clone => no dist => exit 1.

The same command passes in the main checkout: `pnpm check:arch` is green end to end there (god-module scan + depcruise + mcp-catalog-parity 3/3), `pnpm typecheck` exits 0, and the two suites the branch gate blamed pass too (agent.service 32/32, workspace.service 51/51). Master is not red. The probe is.

Blast radius: the recorded red base makes the pre-merge gate attribute failures to 'BASE BRANCH ALREADY RED at the branch merge-base' and withhold the merge, and it deliberately does not route to fix-and-merge (#638). Every merge on this project is blocked by an artifact of the probe environment. #672 is sitting ready-for-merge behind exactly this.

Note the depcruise line in the recorded message is NOT the failure (0 errors, 31 warnings, exit 0) â€” it is just the first thing in the captured output, and it misleads a reader into thinking the arch check failed. The tail is where the real cause is.

Wanted:
1. Run the project's install/setup in the clone before verify (the stack profile already derives installCommand â€” `pnpm install -r` here), or otherwise guarantee generated artifacts like shared/dist exist. Cold-clone realism is the goal; an UNINSTALLED clone is not realism, it is a broken environment.
2. Distinguish 'verify failed' from 'the probe could not run verify'. A probe that cannot build the tree must record an infra outcome, never `red` â€” a false red is worse than no signal, because it silently gates every merge.
3. Surface the failing step, not the head of the log, in the message the gate quotes.

=== SCOPE CORRECTION (filer, after fixing most of this directly on master) ===
Items 1 and 2 are ALREADY FIXED on master. Rebase onto master first; do not reimplement them.
- 4f1af4d02c: verifyBaseBranchHealth runs the stack profile install command in the clone before
  verify; an install that fails or times out records "unverified" instead of "red"; and
  describeRedBaseAttribution renders unverified as 'BASE BRANCH HEALTH UNKNOWN ... NOT attributed
  to it'. Two regression tests added in base-branch-health.test.ts.
- 7a63062737: a SECOND, independent cause of the same total merge blockage — agent.service.test.ts
  port tests were not hermetic. The gate runs inside a board-spawned worktree whose env carries
  KANBAN_BOARD_SERVER_PORT, which resolveLaunchPorts reads first by design (#615), so
  'sets KANBAN_SERVER_PORT in spawn environment' got the board's 3001 rather than its own 3005 and
  failed in EVERY gate run while passing in any clean shell. The tests now save/clear/restore the
  ambient KANBAN_* port vars; the production ladder was correct and is unchanged.

REMAINING WORK = item 3 only. The stored message leads with the head of the captured output (the
depcruise summary, which exited 0 with 0 errors and 31 warnings), so a reader blames the arch check
when the real failure was a pnpm recursive-exec failure far below. Surface the FAILING STEP in the
message the gate quotes instead of the head of the log; tail() keeps the last ~40 lines, so look at
how the combined stdout/stderr message is assembled. If you believe items 1 or 2 are incompletely
fixed, say so with evidence rather than rewriting them.

### #676 gate: the merge train's synthetic `train:<label>` id makes the deferred-install gate a no-op for every member
`priority: critical` · `type: bug` · `tags: gate, merge-train, installs` · `created: 2026-08-20` · `updated: 2026-08-20`

The deferred-install block is keyed only by workspace id:
`packages/server/src/services/pre-merge-gate-installs.ts:17` → `listWorkspaceRepoInstallStates(workspaceId)` → `where(eq(repos.workspaceId, …))`.

The train calls the gate with a synthetic id:
`packages/server/src/services/merge-queue.service.ts:593`
`runPreMergeGate({ id: \`train:${label}\`, workingDir: gateWorktree, baseBranch }, …)`

`train:q…` matches no `repos` row → `rows = []` → `blocking = []` → `null` → **no block**, for every member of the train.

Failure scenario: project on `sibling_install_mode=background`, two tickets with overlapping changed files. `executeQueue` auto-selects the train (`merge-queue.service.ts:663` — `plan.recommendedStrategy === "integration-union"` is enough; no explicit `strategy: "train"` needed). Both workspaces still have `install_state='running'` sibling rows. Individually each merge would be withheld; via the train both land. This is exactly the "unverified merge of code built against missing deps" the feature exists to prevent.

Untested: `pre-merge-gate-install-block.test.ts` unit-tests the helper only, never that a merge path calls it. Note the train's own comment — "a train that skips the gate is exactly what this feature must never become".

Fix: check the install state of every train MEMBER's workspace before landing, not the synthetic id.

- [ ] train consults the install gate per member
- [ ] test asserting a member with a running install blocks the train

### #677 gate: pre-merge gate is blind to sibling repos in a multi-repo workspace
`priority: high` · `type: bug` · `tags: gate, multi-repo` · `created: 2026-08-20` · `updated: 2026-08-20`

`PreMergeGateWorkspace` is `{id, workingDir, baseBranch}` and nothing else
(`packages/server/src/services/pre-merge-gate.service.ts:278-287`), and `changedFiles` comes from
`getChangedFileNames(workspace.workingDir, workspace.baseBranch)` — the **leading repo only**.
But `workspace-merge.service.ts:54` imports `executeSiblingMerges` and does land sibling repo code.

Consequences:
- a multi-repo workspace whose LEADING diff is docs-only gets `docsOnly=true` → verify AND smoke skipped (`:424`, `:647`) while arbitrary code lands in a sibling repo;
- the tier's package/file scoping never sees sibling changes;
- the gate-PASS tree memo keys on the leading tree only.

This is the live half of the tree-memo finding. Fix: fold sibling repo diffs into `changedFiles` (and into the memo key) before computing `docsOnly` and the scope.

- [ ] sibling diffs included in the gate's changed-file set
- [ ] docs-only cannot be true while a sibling repo has code changes

## AI Reviewed

_(empty)_
