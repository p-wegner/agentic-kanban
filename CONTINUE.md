# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-09-08 — board restarted after an overnight death; #1056 finished; board empty

**The stable board was DOWN when this session started** — nothing listening on 3001/5173. Its
log ends mid-cycle at 06:30 UTC with no error, no `[fatal]`, and no shutdown line; the process
(pid 24720, started by yesterday's recovery promotion) was simply gone. Restarted headless from
`../agentic-kanban-stable` on the same built artifact (`stable-20260907`), health green.
**Unexplained and NOT diagnosed** — if it recurs, that silent-death-with-no-log-line is the
thing to chase, and `.kanban/board.log` around 06:30 is the evidence.

**#1057/#1058/#1059 were merged but sitting in Todo.** Their fix commits are all in
`stable-20260907`; the tickets were never moved. Closed against git, not against the ticket text.

**#1040 landed** (`36dc67366d`) — the pnpm-workspace YAML bug was already fixed on master, so
the branch only removed the dead duplicate `pnpm.onlyBuiltDependencies` from `package.json`.
Two earlier merge attempts had died: one when the board died mid-gate, one killed by the
no-progress watchdog.

### #1056 is done, in three commits, and the second one was corrected by the third

`f374ac67c4 fix(#1056)` was MIS-NUMBERED — it implemented #1057's host-admission work. #1056's
own content was untouched until today.

1. **`3ee70dff5a` — the `process.env.TEMP` door.** Two suites
   (`leaked-temp-project-cleanup`, `project-dedup-same-git-root`) were still minting a loose
   `.db` per test directly in `%TEMP%`, *on the day this was worked*, with
   `temp-dir-namespace-guard` green: all three of its passes key off a `tmpdir()` CALL and its
   parse filter skips any file that never writes the word. Both suites now use an `ak-` scratch
   dir; the guard gained a fourth pass that forbids the DOOR (the temp root arrives through a
   variable, so the resulting name is unknowable at the call site). That pass can have no count
   floor — the tree now holds zero env reads, which is both the goal and what a dead pass looks
   like — so it is proven on synthesized source in both directions instead.
   The reaper now states its BACKLOG and escalates on total size; its old "more remain for the
   next run" read identically at 10 and at 510,000, which is how it was skimmed past four times.
2. **`710cc1ccf4` — the gate's temp-health preflight** (#1056's third bullet), beside #1057's
   host-saturation check. A hold now NAMES which unfitness held it.
3. **`975ff94304` — and the calibration in (2) was WRONG, caught by running it.** The 50,000
   entry cap was a guess; the next measurement refuted it.

**The measurement, because it is the reusable part:**

| entries | walk | note |
|---|---|---|
| 707,242 | > 120 s | the incident state |
| 100,324 | 12.7 s | cold cache |
| 87,503 | **0.2 s** | warm cache, minutes later, SAME directory |

A 13 % size change moved the walk 60x — the CACHE changed, not the directory. **So elapsed time
cannot be the verdict**: it would hold every merge on a cold box and admit on a warm one for
identical state. Size is the stable signal, time is only a cost bound on the probe. Cap is now
250,000, budget 20 s. Verified against the live directory: 87,503 walked in 176 ms, admits.

**`sweep-loose-test-db-files.mjs` was also not draining the backlog it is now named as the remedy
for.** #843 anchored it to `test-db-<uuid>.db`; five other suites mint the same shape under their
own names. Widened to match the SHAPE (UUID-shaped *suffix*, so the `test-db-template-<hash>`
cache still cannot match), match set enumerated before applying — 13 prefixes, all board
fixtures, zero directories. **Applied: 13,437 files, 7.0 GB, 100,940 -> 87,503 entries.**

**Verified by:** the 31 previously-red gate suites (375 passed), `temp-health` (6),
`gate-host-admission` (8), `env-read-ownership` (14), `barrel-client-safety` (10),
`temp-dir-namespace-guard` (7), the two repaired suites (6), `pnpm typecheck` clean, and the
live probe. NOT verified by a full-suite run at commit time — the promotion sweep is that.

**Board state: 1036 Done, 6 Cancelled, nothing in flight.**

### Left undone, deliberately

- **The `%TEMP%` directory backlog.** 87,503 entries remain, ~11,000 of them fixture DIRECTORIES
  in prefixes no sweeper owns (`defects-` 2342, `impres_` 2039, `smoke-srv-` 1390, `abs2_`,
  `cli-test-`, `router-`, `ktrefs-`, `compounding-setup-`, `preflight-test-`). All are
  historical: the board's current source mints every one of these as `ak-*`, and the newest is
  1.8 days old. `sweep-temp-dirs.mjs` only knows `kanban-`/`ak-`, and widening it was NOT done
  because several of those prefixes plausibly belong to sibling tools (refactor-skill,
  code-metrics), and the board deleting another tool's temp dirs is overreach. Below the gate's
  250,000 floor, so nothing is blocked.
- **#1056's per-run temp namespace** (`%TEMP%/kanban/<runId>/`) — suggested in the ticket, not
  built.

## 2026-09-07 (evening) — the gate failures were the board KILLING ITS OWN verify runs (#1059)

**This supersedes three diagnoses, including this morning's.** The #1046/#1048/#1049 gate
failures were not machine load (#1006), not `%TEMP%` exhaustion (#1056), and not log truncation
(#1058). The board's own resource sweeper was reaping the in-flight verify process tree.

Caught in the board's own log, twice, each kill under a second before the gate "failed":

```
20:09:52.768 process-kill-allowed           pid=20260 reason=monitor-stale-dev-tree
20:09:53.099 monitor-stale-dev-tree-cleaned rootPid=20260 pids=[16 pids]
20:19:52.845 process-kill-allowed           pid=10464 reason=monitor-stale-dev-tree
20:19:53.154 monitor-stale-dev-tree-cleaned rootPid=10464 pids=[12 pids]
```

**Why it hid so well.** `runStandaloneResourceSweep` fires every 5 minutes on its own timer —
independent of `auto_monitor`, which is off — and a gate takes 5-15 minutes, so essentially every
gate run was killed. The step that dies is whichever the tick lands on (typecheck in one run,
depcruise in the next), and a SIGKILLed process emits nothing. That is exactly the "different
batch each time, no output, nothing correlated" signature the earlier theories were built on. The
discriminator: the second kill landed on an IDLE box (RAM 54%, CPU 25%, nothing throttling),
which rules out all three.

**Mechanism, with the irony.** This project's verify script is
`pnpm check:arch && pnpm typecheck && pnpm test:mine`, so the shell's command line contains
`pnpm test:mine` and matches `isTestTreeProcess` — the #172 heuristic added to reap LEAKED vitest
workers. It holds no listening port (depcruise/tsc/vitest listen on nothing), no protected pid,
and no active workspace session, so it falls into `stale-dev-tree-no-listeners`. The heuristic
that cleans up after a test run is the one that killed test runs in progress.

`protectedPids()` could not have helped: it read only `KANBAN_PROTECTED_PIDS` and
`KANBAN_BOARD_SERVER_PID`, both fixed at launch, so a child the board spawned seconds ago and was
actively awaiting was invisible to the guard deciding what to kill.

**Fixed (`6b98b04ca7`) at ONE seam, not at the gate's call site** — an install, a base-health probe
and a cold-clone build are equally fatal to interrupt. `shared/lib/setup-script.ts` gained a
nullable `SetupProcessObserver` that the server installs in `wireCoreServices`; it fires on spawn
and in the `cleanup()` funnel every settle path already goes through, so timeout/no-progress/abort
kills release the pid too. `process-guard.ts` gained a reference-counted runtime set unioned into
`protectedPids()`.
**Verified by:** `setup-script-pid-protection.test.ts` 7/7 — including a NEGATIVE CONTROL asserting
the tree IS reaped with nothing registered, a real spawn/settle round trip, a real timeout-kill
release, the reference-count case, and a throwing observer; `stale-dev-processes.test.ts` 17/17
unchanged; the five shared setup-script suites 18/18; `pnpm typecheck` 17s.
**Deliberately not changed:** `workspaceAssociations` gates its working-dir match on
`ws.sessionPid`, so an IDLE workspace (i.e. every workspace merged from Review) can never be
associated with a tree in its own worktree. Real second gap, written up in #1059. Dropping the
guard was REJECTED: `associatedWorkspaceIds` is tested before the `stale-worktree-dev-orphan`
branch, so broadening it would keep genuinely orphaned dev servers alive forever in any idle
workspace's directory — trading this bug for #172's.

**#1058 — the ticket's incident attribution is REFUTED (`6875bbfba0`).** Its mechanism
(`process.exit()` dropping queued pipe writes) is real on POSIX but cannot explain a Windows
incident: **Node's pipe writes are synchronous on Windows.** Three repro shapes on this box — 4k
lines to `tail`, 50k/200k lines to `grep`, and 20k lines with the reader PAUSED 4s to mimic a
blocked event loop — all kept the final line, 2.67 MB intact. The hardening was shipped anyway on
its own merits for the containerized/Linux verify path (both `typecheck.mjs` and `test-mine.mjs`
now `writeSync` when not a TTY, and `test-mine.mjs`'s TEE'd child output with them), but the
commit and a board comment both say plainly it does not fix the measured incident.

**Promoted `stable-20260907` via `pnpm promote --recover`.** This was forced, not chosen: the
sweeper killed every gate AND every full sweep, so no ordinary promotion could ever be authorised
— a deadlock #1054's recovery lane exists for. Delta 12 commits / 32 files / **no migrations**,
smoke passed, auto-rollback armed. **A full sweep is OWED** —
`../agentic-kanban-stable/.kanban/promote-recovery.json` records it.

**Filed:** #1059 (this root cause).

**Still true and unresolved:**
- The 8 in-flight branches are all committed and clean; they were never the problem. They still
  need to go through the gate now that it can survive a sweep tick.
- **#1040's branch has an EMPTY net diff** — `git diff <merge-base> HEAD` is 0 lines, because
  `032ed5a56a` re-adds the six `package.json` lines `f1df8b2578` removes. But the underlying fix
  is REAL and still wanted: master's `package.json` still carries the dead
  `pnpm.onlyBuiltDependencies` field, which pnpm warns about on **every** command
  (`pnpm-workspace.yaml` already owns it). So this is not "close as invalid" — it is "keep commit
  1, drop commit 2".
- `%TEMP%` sits at ~100.8k entries (9.4k kanban/vitest fixture dirs), stable, ~10s to enumerate.
  #1056's producer/reaper imbalance is untouched.
- Sibling-scan noise: archived `ticket-sizing-lab` projects point at deleted directories and log
  a warning burst per merge scan.

## 2026-09-07 — %TEMP% exhaustion was killing the gate; recovery lane landed; 15 projects archived

**The headline, because it invalidates four earlier diagnoses:** the pre-merge gate failed four
times across #1046/#1048/#1049 with `exit 1` and NO test output, and the cause was that `%TEMP%`
held **707,289 entries**. NTFS enumeration alone took over 120 s, so vitest died during setup
before it could report anything. Disk space was never involved (208 GB free).

Three of those failures happened on a loaded box, which made #1006 (gate flakes under load, a
different test each time) look like an exact match — it was reported as such, and that was wrong.
The fourth failed on an idle box (CPU 18 %, 4.9 GB usable), which is what refuted it. ~113 minutes
of gate time went into the wrong hypothesis. **A different test batch failing each run is not
evidence of a flaky suite here** — it is whichever batch was running when a temp operation stalled.

Every failing log had carried the answer in its last line, and it was skimmed past four times:
`[test-reaper] removed 500 stale fixture temp dir(s) … capped at 500 — more remain for the next run`.
Against a ~510k backlog a 500/run reaper can never catch up, and that line reads like routine
housekeeping rather than unbounded growth.

**Verified by:** a prefix-allowlisted cleaner removed 605,255 fixture dirs, 0 failures, every
protected entry (`claude/`, `kanban-session-*.out`, `agentic-kanban-mcp-config.json`,
`kanban-verify-*`) intact. Enumeration went from **>120 s (timeout) to 0.45 s** for the remaining
101,989 entries. #1049's gate then ran real tests for the first time (shared: 7 files / 32 tests
green in 5.78 s) instead of dying silently.

**Filed as #1056**, still open — the cleanup was manual and treats the symptom. The defect is the
producer/reaper imbalance: suites create fixture temp dirs they never remove, and the reaper's cap
means the number only grows. Suggested there: make producers use `createManagedTempDir`, have the
reaper report BACKLOG SIZE and escalate when it grows run over run, give the gate a cheap
temp-health preflight, and consider a per-run namespace (`%TEMP%/kanban/<runId>/`) so a run's
fixtures are one directory to remove.

**#1054 — the promote RECOVERY lane, landed `6129ea8f67`.** `pnpm promote --recover` ships a fix
without a full sweep. The design was deliberately cut back after pushback: an earlier 7-gate
proposal was too heavy for a local single-user laptop, where a slow gate costs most exactly when
the box is degraded and the fix is most urgent. `pnpm build` + smoke + auto-rollback already ARE
the gate. What remains is the one thing rollback cannot undo: a **migration** in the delta refuses
unless `--with-migration` is passed, because a rollback restores code but not schema
(`pnpm db:migrate` is forward-only). `--recover` and `--force-sweep` are mutually exclusive; the
lane writes `.kanban/promote-recovery.json` with `sweepOwed: true`.
**Verified by:** `promote-plan.test.ts`, 50/50 green (15 new for the lane).
**NOT verified:** `--recover` has never run end to end, and its rollback path is unrehearsed
(`KANBAN_PROMOTE_FORCE_SMOKE_FAILURE=1` is the seam).

**#1057 — two root-cause fixes, landed `f374ac67c4`.** A saturated host now HOLDS the gate instead
of failing it (`decideGateHostAdmission`, held propagated distinctly all the way to the card badge
so a hold never reads as a verdict about the diff); and `archiveProject` writes
`start_mode=manual`, because `fleetops` and `My_Pet_store` kept launching builders for **three
weeks after being archived**. `unarchiveProject` deliberately does not restore a drive mode.
**Caveat written into the ticket:** the host floor reads `os.freemem()` only, so it catches the
memory case and the CPU case only when they coincide — CPU saturation is what actually burned the
three attempts.

That commit cited `#1056`, a number that had never been filed; the board later assigned 1056 to the
temp ticket. `5698574a74` repoints 17 comments across 11 files at the real #1057. The bad number
stays in `f374ac67c4`'s own message — rewriting a landed commit is worse than one stale reference.

**#1057 broke the #726 complexity gate on master, and that is what actually failed #1049's fifth
attempt.** With `%TEMP%` fixed the gate finally produced real output, and the failure was a genuine
regression from `f374ac67c4`: `runPreMergeGate()` went to 35 branches (grandfathered at 34) and
`runPreLockGate()` to 27 (flat threshold 25, no baseline). The gate-hold edit had added an `if` and
two ternaries — directly below a comment stating the function sits on the branch ceiling. It was
reported as verified because the check run then was scoped and did not include the shared
`@gate:always-run` guard batch that owns this rule.

Fixed by RESTRUCTURING, not by moving the baseline, which is what the gate's own message asks for:
`describeOutstandingInstallsForGate` absorbs the install loop (2 branches inline, 1 via the helper)
and `throwWithheldPreMergeGate` absorbs the two hold ternaries. **Verified by:**
`node scripts/check-god-modules.mjs` OK (peak 41, 19 baselined), `pnpm typecheck` 20s,
`max-file-size` + `check-god-modules-script` green, and 6 gate suites / 71 tests green.

**Board hygiene:** 15 projects archived non-destructively (`archivedAt`, never unregister — #964
cascades away issues/workspaces/sessions), plus `start_mode=manual`. monitor-driven is now **0**,
including `agentic-kanban` itself, so **nothing auto-starts anywhere** until that is restored
deliberately. An orphan `start_mode` pref for an already-deleted project was also found.

**Still true and unresolved:**
- **#1039's fix is not live.** The stable board still runs the old artifact; nothing has been
  promoted. Landing on master does not change the board that operates every project.
- **#1040 is a no-op branch** — its two commits cancel out to an empty net diff, yet it is marked
  ready with score 77. It needs closing as invalid, not merging.
- `mssecflt.sys` leaks kernel pool at ~441 MB/h (6.1 GB held). Org-managed driver — needs an IT
  ticket, not a local change. It is why the box swaps at 5.6 GB usable with CPU idle.

## 2026-09-06 — #1039: an enabled plugin's skill now reaches the checkout AND the worktree, or says why not

**What was true:** `plugin_enabled_test-impact_<id>` = true, the plugin checkout intact, and no
`.claude/skills/test-impact` in the main checkout — so every worktree got the 1.5 MB impact map and
not the tool that reads it. The worktree this fix was built in (`ak-1039`) was itself in that state:
`docs/tests/impact-map.json` present, skill absent, and the runner selected via the profile copy
under `$HOME` (`impactCliOrigin` → `home`). The enable-time junction is the only bridge from a
plugin to a worktree, and nothing re-created it once it was gone; a dangling junction was even
reported `skipped-existing`.

**Landed on this branch (not yet on master):**
- `fanOutPluginSkills` is a module-level export of `plugin-enablement.service.ts`; it replaces a
  dangling junction instead of skipping it.
- `materializeEnabledPluginSkills` (provisioning AND relaunch, via `materializeWorkspaceSkills`)
  re-runs that fan-out into the main checkout when a copy finds nothing, then copies; it returns
  `{ materialized, healed, missing }` and warns loudly for both the healed and the missing case,
  plus a dedicated warning when the map was copied but the test-impact tool was not.
- The gate message names an absent selector: `selection UNKNOWN — selector ABSENT (.claude/skills/
  test-impact/tools/impact.mjs is not in the worktree; …)` via `GateTierInfo.impactSelectorAbsent`,
  set by `resolveGateImpactTierFields`. `scripts/test-mine.mjs` warns when it used a `$HOME` copy.

**Verified by:** the three new `(#1039)` cases in `workspace-provision-plugin-skills.test.ts`
(lost skill healed into checkout + worktree; dangling junction re-linked; unhealable skill reported
in `missing`), `gate-tier-impact.test.ts` (absent-selector clause, and NOT blamed for a mere
resolve failure), `test-mine-impact-selector.test.mjs` (`impactCliOrigin`); `pnpm check:arch`,
`pnpm typecheck` (27s), `pnpm test:mine -- --changed HEAD` (152 files / 1239 tests green).

**Not verified:** why the junction disappeared on the live board in the first place — the exclude
entry proves the enable path once ran. The heal covers every cause; the cause itself is unknown.

## 2026-09-05 — #1047 fixed on master; the gate-floor and promote-evidence backlog filed and started

**Running right now: two group workspaces, on two different accounts, both verified past the point
where the first attempt died.**

- **ak-1041** (#1041 + #1042 + #1043, one group workspace) on `andrena_team_5x` — verified at
  7m39s / 75 turns / 50 tool calls / 0 failures.
- **ak-1044** (#1044 + #1045) on `andrena_team_5x_3`, pinned at creation so two Opus builders do not
  stack onto one subscription.
- **#1038** — still `blocked`. Its worktree holds ~20 files of finished-but-unverified work,
  uncommitted, and its row is pinned to `andrena_team_5x_2`, which resets ~17:40. It cannot be
  re-pinned on the running board (see the promotion note below), so it waits.

**Quota is per-account and the board's reading of it is stale — do not read a fleet percentage as
current.** At 16:05 `fleet status` reported `andrena_team_5x_3` at 100% with the data marked
`stale — 12h 18m old (expired)`, while that account was in fact serving a live session; it reported
`andrena_team_5x_4` at 45% about ninety seconds after the board had proved it exhausted. Exhausted
on measurement today: `andrena_team_5x_2` (~17:40), `andrena_team_5x_4` (~16:50), `default`.
With headroom: `andrena_team_5x`, `andrena_team_5x_3`. The way to tell is to launch and watch — a
6-second exit with a usage-limit banner is the exhausted answer.

**Landed: `dbea2f5a33` — a launch may name the profile it runs on (#1047, item 1 of 3).**
`--profile` on `workspace resume|launch|relaunch`, `claudeProfile`/`profile` in the launch body; it
outranks the profile pinned on the workspace row, and resolves through
`resolveProjectRuntimeConfig` so a `forbidden` account stays unreachable. Verified: `pnpm typecheck`
(33s, 5 packages) and `vitest related` over the three changed source files — 239 files / 2100 tests
green; the new suite's forbidden case asserts the roster-refusal message and its override case fails
without the fix. **It is not live on the board**: 3001 is the stable checkout at `stable-20260905-6`,
so the flag reaches nothing until a promotion — which is why #1038 still cannot be re-pinned.
Items 2 and 3 of #1047 are filed as **#1048**.

**Tried and rejected: promoting the fix today.** `pnpm promote --dry-run` would tag `168e2da63c`,
the sha of the last green sweep (2026-09-04 22:53), not master HEAD — so it would promote a build
without this fix. Getting it live needs a fresh green sweep on master first. That is the mechanism
**#1044** is about, hit for real.

**Also measured:** a workspace's profile is baked at creation and wins over the board default
forever, so moving the Bullseye does not move an existing workspace. ak-1041 and ak-1044 were
deleted and recreated to re-pin them (both worktrees were clean, nothing lost). That is not an
option for #1038, whose worktree is dirty — which is the whole argument of #1047.

**Filed this pass** (all against `agentic-kanban`): #1041/#1042/#1043 (coupled — the
`@gate:always-run` guard floor is 179 files/~546s against a 1-file/3s impact selection, i.e. 99.5% of
an impact-tier gate), #1044/#1045 (coupled — force-sweep and gate-run evidence), #1046 (impact map
has no refresh trigger), #1047 (fixed, item 1), #1048 (its follow-up).

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
