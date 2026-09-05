# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-09-05 — #1013/#1033 closed on measured acceptance, #1020 held open, promote's log split

The open backlog was four tickets. It is now three, and none of the three is a leftover.

- **#1013 (stable/dev split) — CLOSED, all three acceptance clauses measured.** The one that had
  never been RUN was "a deliberately red master on the dev checkout does not affect the stable
  board", so it was run: a syntax error appended to `packages/server/src/lib/oauth-quota-core.ts`
  in this checkout. Over 30 s at 3 s intervals, **3101 went to `000` within 3 s and stayed there
  while 3001 answered `200` on every probe**; on revert 3101 recovered in 9 s. Working tree left
  clean. The other two: both boards up at once (3001 stable/17 projects, 3101+5273 dev/0 projects,
  5173 correctly dead), and the runbook followed cold by session `8a289641` in ~2 minutes.
- **#1033 (node_modules wipe) — CLOSED on its mitigations, with the gap FILED, not absorbed.** All
  three acceptance clauses hold (`safe-rmdir` 4/4; `boot-dist-smoke`'s sidecar + any-exit unlink
  handlers + a reparse scan that refuses the final `rmSync`; the CLAUDE.md rule). But its title
  also asks for a ROOT CAUSE, and there isn't one — how a nested-cwd pnpm run reached main's
  importers is still unproven, so every guard shipped is a stopgap aimed at an assumed door.
  That is #1037.
- **#1020 (BACKLOG_FLOOR 15) — deliberately NOT closed.** `objective.md`'s `## FOCUS POLICY` block
  and the README's weekly-planning checklist are both in place, but the floor is not held: the open
  backlog is 3 against a floor of 15, so the acceptance ("the floor holds for a week") has nothing
  to evaluate yet. Filling it means minting ~14 gate-sized tickets — a producer decision, not a
  code gap.
- **`pnpm promote` no longer logs a board on top of its own audit trail** (`0c32646128`) — see the
  run-6 entry below for what the collision cost. `.kanban/board.log` is the board's; `promote.log`
  is the promotion's. Takes effect on the next promotion, since the spawn happens from THIS
  checkout's script; the board running now still writes to `promote.log`.

**Verified by:** `promote-plan` 28/28 (a new case asserts the paths differ and that the dry run
names both), `safe-rmdir` 4/4, `boot-from-dist-smoke` + `command-safety-guard` 58 passed / 2
skipped, `pnpm typecheck` green in 12 s, a real `promote.mjs --dry-run`, and the live probe series
above. NOT verified: anything about #1020's week-long floor, and #1037's hypothesis.

**Filed while here:** #1038 — `pnpm cli -- backlog export --out BACKLOG.md` from the repo root
writes `packages/server/BACKLOG.md` and reports success, because `pnpm --filter … exec` runs with
cwd = `packages/server`. Every doc that gives that exact command is telling the operator to do the
thing that silently misses. `BACKLOG.md` here was refreshed with an absolute `--out`.

## 2026-09-05 — the two-board operation mode is now reachable from what agents actually read

`docs/two-boards.md` was complete and accurate after #1014; the gap was **reachability** — nothing
loaded by default told an agent the operating consequences, so the runbook only helped someone who
already knew to open it. Audited every doc that mentions the mode (`CLAUDE.md`, both `dev-server`
skill copies, `sentinel`, `BACKLOG.md`, `docs/env-vars.md`) and closed four real holes:

- **`CLAUDE.md` § What This Is** now states the fact the rest depends on: the board answering 3001 —
  and therefore every `mcp__agentic-kanban__*` call and every `curl` in these docs — is the STABLE
  built artifact in `../agentic-kanban-stable`, not this checkout, so **landing a board change on
  master does not change the board you are using.**
- **`pnpm promote` appeared in no CLAUDE.md line and in no skill.** The commit→live loop had no
  second half anywhere an agent looks; it is now a Common Commands bullet (refusal conditions,
  `--dry-run` first, rollback + tag retirement) pointing at §8, and `docs/two-boards.md` is in the
  Documentation Map.
- **`pnpm dev` in the main checkout is now the wrong door** (it takes the stable board's ports and
  operated DB) — the bullet said so nowhere and listed it first. Qualified; plain `pnpm dev` is for
  worktrees.
- **The `sentinel` skill did not know the mode existed**, although §8 names it as the reader of
  `.kanban/promote.log`. It has a check 7 (health + `tag --points-at HEAD` + log tail) and two
  interpretation rows, both saying a `failed-promotion-*` HEAD is the recovery working, not a fault,
  and that re-promoting is not the Sentinel's call.

Two stale claims fixed while there: "tag `stable`" in `CLAUDE.md` and both `dev-server` copies —
there is no moving `stable` tag, promotion mints a dated `stable-YYYYMMDD[-N]` one (verified: the
repo has no such tag) — and the sentinel's `loop.pid` path still pointed into `C:ndrena\`, a
tree that no longer exists, so its step 1 could not have run.

**Verified by:** grep audit of every file mentioning `dev:devboard`/`two-boards`/`KANBAN_BOARD_ROLE`/
`pnpm promote`; live state read at the time of writing (3001 healthy = stable checkout, 3101 healthy
= dev board, stable HEAD `6fa31957dc` carrying `stable-20260905-5` — stable has since moved to
`1da4c46a74` / `stable-20260905-6`, see run 6 below). Docs only — no code touched, so
no suite applies.

## 2026-09-05 — #1014: `pnpm promote` exercised for real against the stable board

The drawbridge was written but had never been RUN. Two runs on the live pair
(`agentic-kanban-stable` on 3001 against `~/.agentic-kanban/kanban.db`, dev board on 3101 untouched).

- **Run 1 — a real promotion.** `node scripts/promote.mjs --force-sweep` tagged
  `stable-20260905-2`, fast-forwarded the stable checkout, skipped the install (lockfile
  unchanged), built, migrated, stopped the running board and restarted it, smoke green
  (17 projects, board status for `agentic-kanban`). **#1035's netstat fix held**: the German
  `ABHÖREN` state column no longer hides the listener, `planPortOwnerKill` allowed pid 32268 by
  its stable-checkout command line, and that pid actually died.
- **`--force-sweep` was needed, and that is the finding.** The last green sweep sits on
  `168e2da63c`, which the stable checkout was already AHEAD of after the #1013 cutover, so a
  plain run promoted an ancestor — and `git merge --ff-only <ancestor>` exits 0 with "Already up
  to date". The run would have tagged, rebuilt, restarted, smoked green and announced a tag that
  is not what runs. `checkPromoteDirection` now refuses before it tags (`feat(#1014)`).
- **Run 2 — the rollback half**, via the new one-shot `KANBAN_PROMOTE_FORCE_SMOKE_FAILURE=1`
  (fails the promotion's smoke after `/health` answered, then is consumed so the rollback's smoke
  is real). It tagged `stable-20260905-3`, deployed it, failed on purpose, reset back to
  `stable-20260905-2`, rebuilt, restarted and re-smoked green — 3001 healthy throughout.
- **Two further defects the rollback exposed, both fixed and both re-verified by another
  rehearsal (runs 3 and 4):** a failed promotion left its tag in `stable-*`, the namespace
  `previousStableTag` searches — so the NEXT failed promotion would have rolled back onto a
  version that had already failed its own smoke. A healthy rollback now retires the tag to
  `failed-promotion-<tag>`, and retired names stay taken so a second sha never reuses the label.
  And the failure path called `process.exit(1)` beside a just-spawned detached child, which
  aborted node (`UV_HANDLE_CLOSING` libuv assertion) and handed a cron a crash code instead of 1;
  it sets `process.exitCode` now. Rehearsal exit code measured: **1**.
- **Run 5 — a second real promotion**, `stable-20260905-5` on `6fa31957d`, so the stable board
  runs current master with all of the above. 3001: healthy, 17 projects, `agentic-kanban` present,
  `[db] opening C:\\Users\\pwegner\\.agentic-kanban\\kanban.db (source: DB_URL)`. Dev board on 3101 untouched throughout (healthy, 0 projects).
- **Run 6 — the refusal, then a third real promotion (2026-09-05 10:02–10:05).** A plain
  `node scripts/promote.mjs` REFUSED on the direction check exactly as run 1's fix intended: the
  last green sweep (`168e2da63c`) is an ancestor of what stable already ran, so there was nothing
  to deploy. `--force-sweep` then promoted the three doc-only commits on top — `stable-20260905-6`
  on `1da4c46a74`, fast-forwarded, rebuilt, migrated, board pid 12364 stopped and 40888 started,
  **SMOKE PASSED** (17 projects) at 10:05:12. The session hit its usage limit at 10:05:14 and never
  reported it; the outcome was reconstructed afterwards from git and the log.
- **The promote log lost that run's opening record.** Its header/sweep/rollback-target/direction/
  tag/fast-forward lines are absent from `<stable>/.kanban/promote.log` between 10:02:39 and
  10:05:01, while the outgoing board's `[loop-lag]` output for those minutes is there — because the
  stable board had been launched by hand with its stdout pointed at that same file, and
  `promote.mjs` itself also gives the board it starts an fd on it (`openSync(logPath, "a")`,
  `scripts/promote.mjs:262`). Two long-lived writers on the Sentinel's audit file. The mechanism of
  the loss is NOT proven (append-mode writes should not clobber); what is measured is that the
  lines are gone. §8's start recipe names no log path, which is what invited the collision.
- Tags now: `stable-20260905`, `stable-20260905-2`, `stable-20260905-5`, `stable-20260905-6` live;
  `failed-promotion-stable-20260905-3` / `-4` retired. `docs/two-boards.md` §8 was rewritten from
  what the runs actually did.

**Still true / next:** a promotion on the honest path (no `--force-sweep`) needs a green sweep
NEWER than what stable runs — i.e. the nightly sweep has to run after this promotion before the
next one can be sweep-authorized.

## 2026-09-05 — #1020: producer side — refill back on, BACKLOG_FLOOR 15, weekly planning checklist

Direct on master, one pathspec commit (`feat(#1020)`), no worktree.

- `scripts/board-monitor/objective.md` **FOCUS POLICY** (hand-authored, below the
  `STRATEGY_BULLSEYE_GENERATED_END` marker) no longer says "DRAIN THE BACKLOG, DO NOT REFILL". It
  now holds `BACKLOG_FLOOR = 15` gate-sized tickets, refill via `$backlog-refill` +
  `$ticket-enhancer`, `coupled_with` grouping at creation (#661), and the source order
  `BACKLOG.md` → `docs/proposals/*` → open items in `CONTINUE.md` → general architecture plan
  Phase 1-2. The generated block still renders `BACKLOG_FLOOR = 0` from the Bullseye; the FOCUS
  POLICY explicitly overrides it. **Not done:** raising the Bullseye's own `backlogFloor` to 15
  (`board_strategy_<id>`) so the two agree — a Bullseye save auto-commits `objective.md`, which
  was not safe in a shared checkout during this batch. Do it from the Monitor view when quiet.
- **Refill pref set:** `backlog_empty_strategy` = `generate_tickets` (was `skip`), via
  `PUT /api/preferences/settings`, read back with `GET /api/preferences/settings`. The key is
  GLOBAL (no `_<projectId>` variant exists — `settings-registry.ts`, `monitor-backlog.ts`).
  Caveat: the in-process path (`resolveStartPolicy` → `backlogRefill`) only honours it in start
  mode `monitor`; agentic-kanban is `manual` (`start_mode_<id>`), so today the refill runs
  through the Conductor's objective.md priority 4, not through `runBacklogRefill`. Flipping the
  start mode is the operator's call (Monitor view → Start Mode), deliberately not made here.
- `scripts/board-monitor/README.md` gained **"Weekly planning pass"** — a six-item human
  checklist (stock, size, source, direction, loop health, record) a Sentinel can prompt for.
- Verified: `objective-capacity-hold-ratchet` + `strategy-objective*` suites green from the main
  checkout (single fork, 2 workers). **Unverified:** that the floor holds for a week and that no
  refilled ticket is a few-minutes change — that is the ticket's acceptance and needs the week.

## 2026-09-04 — direct-master batch: #1029 #1030/#1011 #1031 #1032 landed, #1033 code parts, two master reds fixed

Afternoon batch after the roster wave below: parallel agents on the MAIN checkout, every commit by
pathspec (`git commit -F msg -- <paths>`), no worktrees, no merges. Baseline `b45039a038`; the
range `b45039a038..d2ea5ca51b` holds exactly these ten commits and nothing else.

**Landed, with what verified each (from the commit messages and ticket notes):**
- **#1032** `80f5137ea6` — `monitor/HarnessShareSection.tsx` renders the weekly harness share
  next to the Bullseye budget; MCP `update_issue` takes `tags: {add, remove}` by name; bundled
  skill regenerated; ticket-enhancer points at it. Verified: mcp-server update-issue +
  mcp-catalog-parity, client HarnessShareSection + MonitorPopover, `pnpm skill:check`,
  guard-inventory green; Monitor popover line visually verified (playwright-cli); live stdio MCP
  call set and removed `harness` on a throwaway issue.
- **#1029** `364f135bbf` — `deriveCapacityHold` (shared `machine-capacity.ts`), a generated
  `## CAPACITY HOLD` section in the objective block, live `capacity` on
  `GET /api/projects/:id/monitor-tunables`; the hand-written MEMORY HOLD in `objective.md` is
  retired; new `@gate:always-run` `objective-capacity-hold-ratchet`. Verified: 17 suites green
  (machine-capacity, strategy-objective, board-monitor-next-route, the ratchets); live
  monitor-tunables answers `capacity` (tier 0, hold=false, maxNewStarts=3).
- **#1031** `c15ff65ab0` — `standard` posture sweeps every 12 h instead of 30 min (decision 017
  amendment); `PINNED_SWEEP_INTERVALS` + "no posture under 6 h" pinned in
  `risk-posture.service.test.ts`; `BaseSweepInfo` on `base-branch-health` (`sweep`) and
  `projects/health` (`baseSweep`), rendered in the Project Health Overview. Verified live on 3001:
  28 projects, one scheduled (agentic-kanban, iterate, 24 h), none on a 30-minute cadence.
- **#1030 + #1011** `6cad99720a` — migration 0152: `merge_gate_discards` (sha pair, base-move
  files, `impact_selection`, source/stage/duration/attempt) written non-fatally from the discard
  branch of `runGateWithEvidence`, read back as `gateDiscards` on `merge-status`; the PASSING
  gate's tier message persists on the attempt `detail` and `workspace_merge_gate.message`.
  Instrumentation only — `movedDuringGate` untouched. Verified: 155 tests incl. new
  `merge-gate-discard-persistence` (6) and the schema/index/cascade ratchets; the live server
  applied 0152. Still log-only: the stale-evidence re-run in `resolveMergeGate`; `merge_workspace`'s
  body carries no message.
- **#1033, code parts only** — `200e763406` (CLAUDE.md Worktrees rule), `a07c009c03`
  (`validate-command-safety.js` blocks dependency installs and `pnpm dev` from a nested
  `.claude/worktrees/*` cwd, override `KANBAN_ALLOW_NESTED_WORKTREE_INSTALL=1`; `scripts/safe-rmdir.mjs`
  refuses a tree with an outbound junction; 5 hook cases + `safe-rmdir.test.ts` `@gate:always-run`),
  `dd57255ddd` (boot-dist smoke names its junctions in a sidecar, removes them on any exit, refuses
  to purge while one remains; `--install` alternative added, not run). Verified:
  `node scripts/boot-dist-smoke.mjs --json` ok 8/8. **The ticket stays in Backlog** — the operator's
  forced reinstall (below) is what closes it. Root cause NOT proven; the guard refuses rather than risks.

**Master reds found and fixed on the way (no baseline bumps):**
- `11022584a2` **client-conventions-guard 17 > 16** — #1028's `ProfileQuotaSection.tsx` spelled
  `/api/preferences/quota-usage` itself; now `settingsStore.getQuotaUsage()`.
- `7250908c87` **console-tag-ratchet 22 > 21** — #1027's `console.warn(line)` fallback in
  `worker-profile-placement.service.ts`; the `[worker-fleet]` tag now sits at the call.
- Fixed inline by the #1031 builder: `packages/server/openapi.yaml` was one field (`profiles` on the
  worker register body, #1028 `9be1604ca7`) behind the routes, failing `openapi-drift` for any change.
- Found in THIS close-out: **god-module gate** — `runPreMergeGate` 35 > baseline 34, the
  conditional spread `6cad99720a` added. `d2ea5ca51b` lifts it into `impactSelectionField()`;
  behaviour unchanged.

**Verified by this close-out, on `d2ea5ca51b`:** `KANBAN_TYPECHECK_WORKERS=2 pnpm typecheck` green
(10s warm / 19s); `node scripts/check-god-modules.mjs` OK (1679 files, 19 baselined over
threshold, none grown); `pnpm test:mine -- --maxWorkers=4` (fleet gate: go) was **NOT green** —
mcp-server 43/43 files green, but 14 failing tests in 9 files. Those are now FIXED; see below.

### The 14 reds that close-out found, and where they went (2026-09-04, evening)

The close-out agent that ran the suite hit its usage limit before reading its own log; the log
survived in its scratchpad and a continuation session picked it up from there. Three commits, all
by pathspec on the main checkout:

- **`f486447389` — #1034 (new ticket, filed while fixing).** `scripts/test-mine.mjs` printed
  `[test:mine] scoped to: …` at MODULE scope, outside its main guard, so `guard-inventory.mjs`
  — which imports it for `PACKAGES`/`scanAlwaysRunTests` — wrote that banner onto its own `--json`
  stdout whenever `KANBAN_TEST_PACKAGES` was set, and `guard-inventory.test.ts` died in
  `JSON.parse`. The env that sets that variable is **the pre-merge gate's own scoped tier**, so a
  guard suite went red purely because the gate had narrowed its scope. Both notices moved into an
  exported `announceScope()` called from inside the guard; the suite gained the case that pins it.
- **`bcf28d1607` — six reds from the batch and its predecessors.**
  `merge-gate-extraction.repo.test.ts` (3) learned #1011's `workspace_merge_gate.message` column
  (and applies 0152 beside 0144/0148 in the backfill case); `exec-result-helper-adoption`'s two
  NEW hand-rolled `.code` reads (`merge-gate-evidence.ts` from #1030, `test-impact-map.service.ts`
  from #1018) now use `execSucceeded`; `repository-projections-ratchet`'s two re-spellings
  (`auto-start.repository.ts` #1021, `issue/heal-ticket.repository.ts` #1016) spread
  `issueTextColumns`; the `worker-running-session-silence-ttl` stub gained #1027's
  `noteAttestedProfiles`; the `.codex/skills` mirrors of `board-monitor` (#1029) and `dev-server`
  (#1013) were resynced from the canonical `.claude` side.
- **`5e9d66160` — the four client reds, all pre-batch.** `RosterCandidate` moved DOWN from
  `components/settings/ProjectRosterEditor.tsx` to `lib/rosterEditor.ts` (a `hooks/` module may
  not name a `components/` type, and depcruise cannot see a type-only edge), the editor
  re-exporting it; `useProfileRoster` migrated off its own fetch-in-effect ladder onto
  `useApiResource` (#513), keeping `reloadKey` as a `reload()` on CHANGE so a nonzero first render
  does not double-fetch; `StrategyTargetsView`'s Monitor-policy field table hoisted to module
  scope as `POLICY_NUMBER_FIELDS` + `PolicyNumberKey`, which takes it from 510 back under its 509
  entry (505) instead of raising the ring, and both stale shrinks were banked (509→505,
  `SettingsPanel` 429→426).

**No baseline was raised and no expectation loosened** — every ratchet is satisfied by fixing the
call site.

**Verified on `5e9d66160`:** the five previously-red server suites 34/34,
`exec-result-helper-adoption` 3/3, the three client suites + `ProfileRosterTable.test.tsx` 24/24,
`KANBAN_TYPECHECK_WORKERS=2 pnpm typecheck` green (35s, 5 packages). NOT re-run: the whole
`test:mine`, so "the rest of the suite is still green" is inherited from the 16:08 log, not
re-measured.

**Still red, and only this:** `lint-arch-gate.test.ts` (2) — `chalk.Instance is not a constructor`.
Measured cause: the #1033 wipe left `node_modules/.pnpm/dependency-cruiser@17.4.3/node_modules`
holding only its self-link, and the root `node_modules` has 11 entries with no `chalk`. It needs
the operator reinstall below; nothing in the source is wrong.

**Remains.** Operator: the #1033 forced reinstall (`pnpm install -r --offline --force` in MAIN with
the dev server stopped — see the pass below). **#1020 deliberately held** — it feeds the dev board,
which needs #1013's stable/dev split, still In Review. `BACKLOG.md` re-exported (4 open issues; the
committed file was the 2026-08-24 export, so the diff is a refresh, not a format change).

## 2026-09-04 — the profile-roster wave landed; the cut-off merge batch finished by hand

The 2026-09-04 session (0cf4fadb) drove #1025 → #1026 → #1028 → #1027 and hit its usage limit
at 12:22 UTC with two merge subagents mid-flight. This pass finished them. Everything below is
verified against master and the live board unless it says otherwise.

**Landed on master today, in order:** `7639c4b7bd` (#1026 follow-up: `profile-selection-reason`
moved to `server/src/lib`), `955553d3a0` (**#1027** merge, feature commit `eeaa0e5261`),
`06c5512005` (temp-dir fix `76c6d7ddf3` for #1012/#1024), `bbd76da50c` (guard inventory),
`edbc4fabd4` (CONTINUE archive move). Earlier the same day, by the cut-off session: #1025
(`f543bdfe03`), #1026 (`80d2d8380c`), #1028 (`592479ad35`), the scripts-tier git adapter
(`550a82063a`).

**What the cut-off merge agent had left.** `worktree-agent-a4f985c7d4f1a39cb` sat in an
interactive rebase of #1027 onto master with ONE conflicted file, `oauth-quota-provider.ts`
(master's #1023 threads `nowMs` per tick; #1027 extracts the engine to a shared poller). Its
"keep both" resolution was in the working file but the shared poller still owned a clock, so it
would not have typechecked. Resolved: the poller holds no clock, `refreshOne(profiles, nowMs)`.

**Then the branch was red on five more gates, all fixed before it touched master:**
- **`shared-lib-single-consumer-ratchet`** — #1027's three new modules (`local-profile-discovery`,
  `oauth-quota-core`, `worker-profile-attestation`) had one consuming package. Moved into
  `packages/server/src/lib` like #1024/#1016, no grandfather entry. The same ratchet was ALREADY
  RED ON MASTER from #1026's `profile-selection-reason.ts`; fixed first as its own commit.
- **four suites failed to load** — `worker-profiles.ts` still imported `profile-attributes` from
  shared, which master had moved in #1024.
- **`time-injection-spelling-ratchet`** — `nowMs?: () => number` grew 2 → 3. The attestor now
  takes `current(nowMs?)` / `refreshQuota(nowMs?)` instead of a clock option.
- **`function-nloc-ratchet`** — ninth disclosed movement in `function-nloc-baseline.ts`:
  `createRemoteAgentService` 637→638, `createWorkerAgentRunner` 351→358.
- **`temp-dir-namespace-guard`** — #1027's fixture prefix `ak1027-` → `ak-1027-`; the two
  remaining offenders were #1024's and are what the temp-dir branch fixed.

**Verified by what.** On master after both merges: `pnpm typecheck` green (18s),
`check-god-modules` OK, `promote.mjs --dry-run` plans, 4 shared + 18 server suites green
(197 tests, incl. every ratchet above), `/api/health` ok, `GET /api/profile-roster` returns the
13 known profiles. `pnpm lint:arch` still crashes with `chalk.Instance is not a constructor` —
environmental, see #1033 below, NOT a code finding.

**Board.** #1027 Done (its stale `blocked` workspace `0dba7fb7` was CLOSED via
`POST /api/workspaces/:id/close`, not deleted — its branch had been reset to master and held no
unique commits; the ticket could not move to Done while it was open). #1028 Done after the owed
visual verification with playwright-cli against 5173: Settings › Agent shows the per-project
narrowing editor (13 profiles, reserve checkbox, "Pool exhausted at 90 %", "Would launch on
claude:anth") and the global roster table (Profile/Role/5h/7d/Resets/Measured/Cooldown, one
profile with a live 10 %/2 % reading, the rest `unknown`/`never` because the poller measures
one profile per tick); the Monitor view shows no roster warnings, correctly —
`ProfileRosterWarningsSection` returns null unless a reserve start or role conflict exists, and
every profile here is `pool`. Note comments with shas are on #1027, #1028, #1012, #1024.

**Cleanup.** The three landed `.claude/worktrees/agent-*` worktrees and their branches are gone.
Five OTHER `agent-*` directories remain under `.claude/worktrees/` that `git worktree list` does
not know (a0c47…, a27c3…, a49a3…, a6056…, aba96…) — not this session's, left alone.

**Not done, deliberately — the #1033 dependency repair.** Main's `node_modules/.pnpm/*` lost
sibling links (e.g. `.pnpm/dependency-cruiser@17.4.3/node_modules` holds only itself, so
depcruise resolves the hoisted chalk 5 and dies). `pnpm install -r --offline` is a no-op
(lockfile satisfied). The fix is `pnpm install -r --offline --force` in MAIN with the dev
server STOPPED (running vite holds `lightningcss-win32-x64-msvc` open → EPERM), then restart
via the `dev-server` skill. Not run here: it takes down the board that operates every project
while four other sessions sit on the box, and the only thing it currently blocks is
`lint:arch`. Decide, then run it as one deliberate operator step.

**Tried and rejected.** Deleting #1027's stale workspace (would cascade the builder's session
record; `close` keeps it). Grandfathering the three shared modules on a promised worker package
(the fleet worker IS `packages/server/src/worker`, so the count would be 1 forever — the same
reasoning #1024 wrote down).

## Where this stands (2026-09-04)

**Read this section before anything below it.** Everything under a dated heading describes the
state at the time it was written. Standing state lives here and nowhere else.

### Verified now (2026-09-04)

- **Branch `master`, working tree clean, 86 commits ahead of `origin/master`.** `origin` =
  GitHub `p-wegner/agentic-kanban`; there is a second remote `gitlab` — do not confuse them.
- **The profile-roster wave is complete:** #1024 (attributes), #1025 (roster roles), #1026
  (predictive rotation), #1027 (worker attestation, protocol v2), #1028 (roster UI) all Done.
- **Board (agentic-kanban project):** In Review #1013, #1014 (blocked); Todo empty; Backlog
  #1020 (held on #1013), #1033 (code landed, operator step open). #1029, #1030, #1011, #1031,
  #1032 Done today by direct-master commits, and #1034 (the test-mine import-time banner, filed
  and fixed during the close-out) Done in `f486447389` — shas in the top pass.

### Next steps, in order

1. **Operator: the #1033 forced reinstall** (see the roster pass) — one deliberate step with the
   dev server stopped; it un-breaks `pnpm lint:arch` and closes #1033.
2. **#1013 / #1014** (In Review) — stable/dev board split and the promote script; #1014 is
   marked blocked. #1020 (producer side) starts only after #1013 lands.
3. **Operator: decide the push.** 86 commits, clean fast-forward; the Linux CI run is what #923
   needs.
4. **`pnpm --filter agentic-kanban test` on an idle box** — the whole-repo gate (incl. the
   known-flaky set `test:mine` skips) remains the outstanding verification.

### Operator flag — RESOLVED, not open (corrected 2026-08-27)

`packages/server/kanban.db` does not exist; CLI and server both open
`C:\Users\pwegner\.agentic-kanban\kanban.db`. The `[db] opening ... (source: home-fallback)`
line is the NORMAL path, not a warning — do not re-file it as a defect.

## Archive

Passes older than 2026-09-04 have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so it records what each session believed at the time. Look there for the
2026-09-01/02 wave (#986/#992/#994/#995/#996/#997/#998/#999 and the verification-cadence pass), the
2026-08-25..28 waves (#924, #807, #903, #901, #857, #874, #887, #899/#898/#897, #894, #881, the
26-ticket direct-master batch, #859's root cause, the UI overflow sweep), and before them the #680
gate-hermeticity history, the "batch 1 of N" true-state table (#691), the 2026-08-21/22/23 waves,
the adversarial review, and the hook-cost investigations.
