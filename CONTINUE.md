# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-09-09 (evening) — the Jira epic is DONE; board backlog is empty but for two new tickets

**#1075 and all six children are Done.** Landed this pass, in order: #1079 (`a85b5da4ea`),
#1078 (`082e7e13dc`, with two review fixes — pagination past the 500-item cap, and treating a
board issue with no local record as a CONFLICT rather than a blind overwrite), #1080
(`5125fd373a`), #1081 (`5e6809dc1a`). #1073 was closed without work: its fix was already on
master at `63aad103ef` and its workspace held zero commits.

**Board backlog is now 2 open, both filed today and both by this session** — #1083 (agent-stream
drops every Claude `tool_progress` event; 483 in one day, and the ONLY unrecognised type, so it is
one parser gap rather than general drift) and #1084 (see the correction note below).

### What actually blocked the merges for ~4 hours, in the order it was found

1. **A broken worktree `node_modules` in ak-1081** — not only the documented empty
   `packages/e2e` (`verify_infra_missing`), but a missing `depcruise` and `typescript` at the
   ROOT, so `lint:arch` failed with *"Der Befehl depcruise ... konnte nicht gefunden werden"*.
   `ALLOW_CROSS_WORKTREE_WRITE=1 … pnpm install -r` in that worktree fixed both.
2. **Wedged verify processes blocking the whole verify-chain queue.** A `marker-worker.js` from
   `ak-verify-gate-test-TxhLp9` had been alive **6.9 hours for 2.1 s of CPU**, zero children, zero
   CPU delta over 8 s — a leftover from the morning hard-interrupt — plus an orphaned 51-minute
   vitest for the already-merged #1078. The chain queue had backed up to 5. Killed by pid.
   **The check that matters is CPU delta over ~10 s plus child count, NOT age or zero-CPU alone**:
   a legitimate parent (`test-mine.mjs`) waiting on a working child shows exactly zero delta and
   is NOT wedged. That distinction nearly cost a live gate.
3. **A real defect on #1081** — `plugins.ts:335` passed `body.values` (`Record<string, unknown> |
   undefined`) into a required parameter, `TS2345`. Routed to `fix-and-merge`, which applied
   `body.values ?? {}`, rebased and regenerated `openapi.yaml` + the bundled skill files.

None of it was the base-branch-health probe, which is where the previous note pointed. The probe
is STILL `unverified` at `a43cb610` and merges landed anyway — so a stale base health does not
block a merge the way that note implied.

### A correction worth keeping, because it was made twice

`#1084` was first filed as a HIGH-priority "leaked build-semaphore slot permanently starves the
base-health probe". **That claim could not be reproduced and the ticket has been corrected and
downgraded.** The evidence was two 40 s samples showing zero processes matching
`ak-verify|test-mine|vitest` while `reprobe` said `gate_running` — but that regex does not match
`check-arch.mjs`, `depcruise` or `tsc`, and a gate spends ~100 s per run (48 s arch + 55 s
typecheck, measured) in exactly those phases. Re-tested with a broad matcher, gates were
continuously present and `gate_running` was correct every time. What survives is narrower and real:
**a reprobe refusal names no holder and no age**, so "legitimately busy" and "stuck" are
indistinguishable without reading source.

The same error — inferring a CAUSE from a point-in-time reading — was also made this afternoon
about memory: a 17:35 measurement (slidesmith 4.64 GB vs board 1.08 GB) was used to argue the
morning's 10:56 stall had been misattributed to the board. The timestamps refute it, and the
morning session's own 8.3 GB → 2.0 GB drop when it stopped board-side work supports the ORIGINAL
diagnosis. A reading proves a moment; only a timestamp proves a cause.

### Operating state left behind — read before driving this board again

- **`wip_limit_<board>` is 1, deliberately, and has NOT been restored to 2.** It was lowered after
  the morning stall (note that `resolveWipLimit` makes `wip_limit_<projectId>` BEAT the Strategy
  Bullseye, #654 — the Bullseye said 1 while the effective limit was 2). Raising it back is a
  one-line preference write and a judgement about machine load, not about the project.
- `start_mode_<board>` was temporarily set to `manual` to stop the monitor queueing fresh gates,
  and **has been restored to `monitor`**. Verified via `GET /drive`.
- **The stable board is 37 commits behind master** and still on `b7fd0ceff6`. Everything above is
  on master only — `pnpm promote --dry-run` first, per `docs/two-boards.md` §8.
- The pnpm store remains clean (0 corrupt of 24,515 scanned).

### Cross-session note

The RAM pressure this afternoon was largely a runaway `slidesmith` build in another live session
(an infinite loop on a malformed table, since fixed and committed there). It was resolved by
MESSAGING that session rather than killing its processes — `ListAgents` + `SendMessage` work
between local sessions and are the right tool when another agent's work is the load. Two idle
`tools/deck-serve.js` processes (ports 8931/8932) from a third, older session were deliberately
left alone.

## 2026-09-09 (later) — pnpm store is CLEAN again; Jira epic resumed after the RAM stall

**The store corruption above is gone: a full scan of `~/.pnpm-store/v10/files` reports 0 corrupt
of 24,515 files across 259 buckets** (`fs.statSync` on every entry; the failing call in the
recorded probe was a `stat`). The previous pass's bucket-rename workaround held. The
`ERR_PNPM_UNKNOWN ... stat '...files\e0\0705c803...'` still visible in `board.log` is the
**14-hour-old cached probe result being re-reported**, not a fresh failure — `e0` and
`e0.corrupt-20260909` both still exist and `e0` now stats fine.

**So the thing blocking every merge is not the filesystem, it is that `base_branch_health` was
never re-probed.** The gate refuses with `BASE BRANCH HEALTH UNKNOWN (a43cb610, checked 14h ago)
— Probe result: could not prepare the base clone`. `POST …/base-branch-health/reprobe` answers
`skippedReason: "gate_running"` while any verify chain is in flight, so the re-probe has to be
requested when the chain queue is empty. **Not verified: that a fresh probe now passes** — it had
not been obtained when this was written.

**Leftover from the workaround, safe to delete once the filesystem is trusted:**
`files/e0.corrupt-20260909` (and the sibling `8c`/`fd` renames named in the pass above).

### Landed this pass

- **`perf(gate)` `8c95f84563`** — the eleven `when:` scopes the interrupted session had applied
  but never committed. Verified by `always-run-guard-runtime-ratchet`,
  `always-run-marker-ratchet` and `always-run-dirs-lockstep` (32 tests green). Measured per-diff
  guard floor: routes/services-only 357s → 315s, client-only 253s → 223s, scripts-only 222s →
  183s. `BASELINE_TOTAL_MS` is deliberately unmoved — it prices the WORST case (an unknown change
  set still forces everything), which `when:` does not change.
- **#1079 merged** (`a85b5da4ea`) via a direct `POST /merge`; it took the `already-passed`
  persisted review-exit verdict rather than a fresh gate run.
- **#1073 closed as Done** — its fix was ALREADY on master (`63aad103ef`, the `startMode` check in
  `drive-preflight.service.ts` plus `DriveDashboard.tsx` rendering the verdict, covered by
  `drive-preflight.test.ts`). Its workspace held zero commits: stale board state, not lost work.
  The empty workspace was deleted before the status change.

### Operating state deliberately changed

- **`wip_limit_<board>` 2 → 1.** The Strategy Bullseye already said `activeAgentsTarget: 1`, but
  `resolveWipLimit` makes `wip_limit_<projectId>` BEAT the Bullseye (#654), so the effective WIP
  was 2. Set to 1 after the previous session had to hard-kill an 8.3 GB node tree. **Restore it to
  2 when the machine is trusted again** — this is a throttle, not a decision about the project.
- `verify_max_workers_<board>` is 2 and `verify_gate_strategy_<board>` is `impact` (both
  pre-existing, both left alone).

### Still open, in order

1. **#1081** — reviewed clean, `readyForMerge: true`, gate queued. **Do not re-POST `/merge`**:
   each call appends another verify chain (three were queued this way before it was noticed), and
   the chains serialize, so re-triggering makes it strictly slower. Trigger once, then watch
   `board.log`.
2. **#1078** — was a ZOMBIE `active` (its agent died in the hard kill at 10:48 but the row was
   never reconciled; the startup sweep missed it). Cleared to `idle` with `POST /stop`. Branch
   holds 2 commits and a HANDOFF.md; needs a relaunch to finish, then review + merge.
3. **#1080** — not started.
4. **#1075** — the epic; closes when #1078/#1080/#1081 land.

**#1078 and #1081 both carry a sticky "hit a claude usage limit" signal**, which makes the monitor
log `Needs attention … skipping relaunch` every cycle even though the quota block's release time
(02:20Z) has long passed. An explicit `POST /review` bypasses it and worked for #1081; the
allowlist permits all four `andrena_team_5x*` profiles, so this is a stale per-workspace flag, not
an exhausted account.

## 2026-09-09 — NTFS corruption in the pnpm store is what `verify_infra_missing` meant

**#1077 and #1082 were held by the pre-merge gate as `verify_infra_missing`, four identical
failures each. The cause was not the board.** Both worktrees had an EMPTY
`packages/e2e/node_modules`, so `packages/e2e` could not resolve `@playwright/test`; the
`TS7006: Parameter 'dialog' implicitly has an 'any' type` in the gate message is a downstream
symptom of the missing module, not a code defect on either branch. The board's classification
and its auto-install retry were both correct — the retry just could not succeed.

**Why the install could not succeed: individual files in `~/.pnpm-store/v10/files` are corrupt
at the NTFS level.** They list in a directory read but `stat`/`open`/`unlink` all fail with
`UNKNOWN`, and `del` reports *"Die Datei oder das Verzeichnis ist beschädigt und nicht lesbar"*.
A full scan found 2 of 24,315 corrupt; a further ~127 files written during a retry produced one
NEW corrupt entry, and a later retry corrupted a file inside
`ak-1077/node_modules/.pnpm/hasown@2.0.3/`. So corruption is being PRODUCED during writes, not
merely left over.

Workaround that unblocked both worktrees, since a corrupt entry cannot be deleted but its PARENT
can be renamed: rename the affected store bucket aside (`files/e0` -> `files/e0.corrupt-20260909`,
same for `8c`, `fd`) and re-run `pnpm install -r`; pnpm re-fetches the bucket. Three buckets plus
one worktree package dir are currently renamed aside and can be deleted once the filesystem is
repaired. Both worktrees now hold a correct `packages/e2e/node_modules`.

**Not verified: that the gate now passes.** The merges were deliberately NOT re-triggered —
`fleet status` reported RAM at 100% with 8.3k page-faults/sec from disk and 39.8 GB committed
against 27.6 GB physical, which is exactly the condition the capacity rule says not to start a
test/build run in. Re-run the gate for #1069 and #1077 (both `readyForMerge`) after a reboot.

**Probable root cause, unproven:** the System log carries recurring NTFS Event 7 *"unterbrochener
Schreibvorgang"* (interrupted write) on 03.09, 04.09, 06.09 x2, 08.09 and 09.09 05:07 — clustering
on long-uptime days. `fleet status` names a kernel-pool leak in `mssecflt.sys` (6.5 GB, +155 MB/h,
org-managed) as the memory driver. `Get-PhysicalDisk` reports the SSD Healthy, so this is
filesystem/driver, not failing hardware. `chkdsk C: /scan` needs elevation and has NOT been run.

## 2026-09-08 — Drive: a target-only drive could never acquire a scope (#1071/#1072/#1073)

**Trigger: the operator started a drive from the Drive view with a target and no epic, and the
dashboard sat at 0/0 forever.** Its empty state said "link a meta/epic issue with children to
this drive" — an action the board offered NOWHERE. `StartDriveForm` sets `metaIssueId` only at
creation, there is no edit path, and the only populated route ran the other way round (create an
epic, decompose it, and let `confirmEpicDecomposition`'s `driveTarget` auto-create the drive
record). `drive-dashboard.service.ts` referred twice to "the drive-epic seeder"; grep says those
two comments are the only occurrences in the repo — it was never written.

**`POST /api/projects/:projectId/drives/:id/plan` is that seeder**, and deliberately the
smallest thing that unblocks the flow: it creates ONE epic from the drive's target (full target
preserved in the body, completion contract promoted to its own section, `epic`-tagged, landed in
Backlog), links the drive to it, and returns it. It generates no children and calls no model —
the caller's next step is the ordinary `/decompose` -> `/decompose/confirm` pair, so there is no
second way to fan out an epic. Idempotent: a drive has exactly one meta issue, and a second epic
would silently split its scope since the dashboard reads `metaIssueId` alone.

The empty state is now an action (`DriveScopePlanner`), and one button covers both dead ends
precisely because `/plan` is idempotent — "no scope at all" and "an epic nobody decomposed" take
the same path and the caller need not know which it is looking at.

**#1073 — preflight was a false green, measured on the operated board.** `GET /drive` returned
`enabled: true` with `startMode: "manual"`, and `GET /drive/preflight` returned `ready: true`
across nine green checks — for a configuration in which no ticket auto-starts at all. The
`autodrivePrefs` check reads the legacy `board_autodrive_<id>` keystone; Start Mode is what
CLAUDE.md calls "the one decision EVERY auto-start path consults". Added a `startMode` check
(`manual` blocks and is auto-repairable, `conductor` passes and is deliberately NOT
auto-repairable — the one-switch repair writes `monitor`, which would demote a project whose
out-of-process loop is its sole driver), and surfaced the preflight verdict on the Drive
Dashboard, where an operator actually asks "is this running?".

**Three client ratchets fired on the first draft, and all three were right.**
`api-response-validation`, `fetch-in-effect` and `function-nloc` together said: the dashboard had
grown a hand-rolled fetch ladder and crossed 400 nloc. Fixed as directed rather than baselined —
schemas registered for both new endpoints, preflight moved onto `useApiResource`, and the
planning concern extracted into its own component. `wire-dto-single-declaration` then caught the
new `DecomposableIssue` as a rename-dodge duplicate of `DrivePlanIssue`; the shape is now
declared once in `shared/types/api/issue.ts` and consumed by both.

**Verified:** 12 new `drive-planning` tests, 3 new `drive-preflight` cases, full client suite
(185 files / 1768 tests), `pnpm typecheck`, `pnpm check:arch`. Note the FK finding behind one
test: `drives.meta_issue_id` is `on delete set null`, so a dangling meta pointer is structurally
impossible and `planDrive` needs no recovery branch for one — deleting the epic RELEASES the
drive, which the test asserts instead.

**Still open, and NOT part of this pass:** #1071's second half — attaching an *existing* epic to
a drive from the UI (`PUT /drives/:id` already accepts `metaIssueId`; only the picker is
missing). The plan path covers the common case, so this was left rather than widened.

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

### Later the same day — archive pass, #1060, and the %TEMP% dir backlog closed

- **Third CONTINUE archive pass** (693 -> 146 lines): ten dated 2026-09-04..09-07 passes moved
  verbatim to `docs/archive/CONTINUE-archive.md`. The standing "Where this stands" section was
  REWRITTEN rather than archived — it was dated 09-04 and every load-bearing line had gone false.
- **#1060 fixed and Done.** A RED sweep verdict now stops refusing a re-probe once master is fixed
  PAST it: `planSweepAcquisition` takes `headSha` and splits the red case. Red-on-the-tip refuses
  exactly as #1044 intended; red-on-a-superseded-commit requests a fresh sweep. Unknown HEAD or a
  sha-less row keeps the refusal — a comparison that cannot be made is not a licence.
- **#1038 verified end-to-end while refreshing `BACKLOG.md`**: `pnpm cli -- backlog export --out
  BACKLOG.md` from the repo root now writes the repo-root file and prints the ABSOLUTE path, which
  is exactly that ticket's acceptance. The backlog is now **0 open issues**.
- **The `%TEMP%` directory backlog is drained** — the item this file listed as deliberately not
  done. Ownership is DERIVED, not listed: for every `ak-<X>-` prefix the repo mints today, a bare
  `<X>-` dir in `%TEMP%` came from an older revision of that same call site. Behind
  `sweep-temp-dirs.mjs --legacy`, with a specificity filter that declines generic bare forms
  (`plan`, `ws`, `fork`) and numeric ticket fragments. **22,704 removed, 0 failed; %TEMP% 91,041
  -> 68,288 entries, walked in 0.18s.**

**Twice today vitest was green while `tsc` was not**, both times on a hand-typed `.d.mts` for a
plain `.mjs` script (`promote-plan.d.mts`, then `legacy-temp-prefixes.d.mts`). For these scripts
the suite alone is not the gate.

### Left undone, deliberately

- **#1056's per-run temp namespace** (`%TEMP%/kanban/<runId>/`) — suggested in the ticket, not
  built.

### Later still — the view-thinning epic finished (#1062-#1068)

Asked to analyse which board UIs are noise. The answer came from the DATABASE rather than from
taste, and it closed an epic that had been open since 2026-08-06:
`docs/view-inventory-and-plugin-extraction.md` had a six-step plan with step 6 never executed,
and its own blocker was stated in the doc — "there is **no view-usage telemetry** anywhere in
client or server. Every judgment below is from structure and role, not from observed use."

**The telemetry was never needed.** The board already records what each feature PRODUCES, so
querying the operated DB (29 projects, 2119 issues, 1314 workspaces, 2026-07-07..) answered it:
a feature whose table has never held a row has never been used.

| # | What | Result |
|---|---|---|
| 1062 | Flaky Tests | **deleted** — 0 rows, and NOT starved: 2034 `test_runs` incl. 187 failures |
| 1063 | Time tracking | **deleted** — 0 entries ever |
| 1064 | Showdown | **deleted** — 0 showdowns ever |
| 1065 | Milestones | **view** deleted; field/CRUD/format KEPT |
| 1066 | Metrics+Insights+Workflow Analytics | folded into Analytics tabs |
| 1067 | Capacity+Stale Work | folded into Focus tabs |
| 1068 | Hotspots + Quality Metrics | moved to the code-metrics plugin (epic step 6) |

Registry **27 -> 18** views, 13 primary / 5 behind "More", single-key shortcuts **17 -> 12**.

**Two zero-row features were deliberately KEPT**, and this is the rule worth carrying: merge
trains (`merge_trains` 0) only form above a queue-size threshold this board never reaches at
WIP=1, and scheduled runs (`scheduled_runs` 0) is a capability flag on `resolveStartPolicy`
(decision 008). Zero rows means "never fired", NOT "not load-bearing".

**#1068 was not the rewrite the epic feared.** The doc warned that extracting a view means
rewriting it as a standalone iframe app. By now the `code-metrics` plugin had ALREADY built both
replacements, so the board views were the duplicates. One real gap had to be closed first, in the
plugin (`code-metrics-skill` commit `7be65c1`): its trend panel filtered the series to `arch.*`,
which would have orphaned the board's own built-in `quality-metrics-collector` (`code.*`/`git.*`
keys) the moment the board view went. **The `/api/projects/:id/quality-metrics` endpoints and the
`quality_metrics` table STAY** — the plugin reads them; only the display case moved.

**No destructive migrations.** Every deletion removed UI and API surface and left the schema, FKs
and cascade-delete entries alone (this ships on npm; another board may hold rows). Cascade
regression tests were kept by seeding rows directly instead of through the removed endpoints.

**Two mistakes worth remembering, both caught by things other than my own review:**

1. **`#1069` was my own false positive.** I read the disclose-context hook's bare relative path in
   `.claude/settings.json` as the CLAUDE.md "never a bare relative path" violation and anchored it
   with `$CLAUDE_PROJECT_DIR`. It is a DELIBERATE exception (#922/#1000):
   `$CLAUDE_PROJECT_DIR` is empty in `claude -p` sessions and is pre-expanded textually, so the
   anchored form resolves to a bogus path and dies in exactly the mode the hook exists for.
   `claude-md-git-invariants.test.ts` asserts the relative spelling and records that
   `2ebe615fb3` already made this mistake once. **Reverted (`70b60cd08`).** Only the FULL server
   suite caught it — my targeted runs never touched that file. The underlying observation is
   still real and #1069 stays OPEN with the corrected diagnosis: the hook dies with
   MODULE_NOT_FOUND once the Bash tool's cwd moves into a subdirectory, and the fix must preserve
   the relative spelling.
2. **#1067 shipped a dead URL dimension.** `FOCUS_TABS` was declared and wired, the tabs rendered
   and switched — and the address bar never changed, because `VIEW_TAB_REGISTRY` (what the ROUTER
   reads) was never updated. Every existing registry test iterates that registry, so all of them
   passed. **Found by visually verifying with playwright, not by a test**, which is exactly why
   that convention exists. Fixed in `8ccf0e49c` with a source-scanning guard: every
   `export const X_TABS` in `viewTabs.ts` must be registered. Mutation-verified.

## Where this stands (2026-09-08)

**Read this section before anything below it.** Everything under a dated heading describes the
state at the time it was written. Standing state lives here and nowhere else.

### A registration side effect that undid #1040 (#1070)

Registering this checkout on the DEV board (for the visual verification) made the registration
scaffold write `pnpm.onlyBuiltDependencies` back into `package.json` and **auto-commit it** as
`Test <test@test.com>` (`81a75e1b9f`). Byte-for-byte the block #1040 removed this morning, and
dead for the same reason — pnpm 10 no longer reads that field and warns on every command. So a
landed ticket was silently undone eight hours later by registering the repo. Reverted
(`91c5cb1439`), filed as **#1070**: the scaffold writes the LEGACY location without checking
`pnpm-workspace.yaml`, and a registration auto-commits to the user's repo on master under a
synthetic identity — which is what put it in history rather than in the working tree.

### Verified now (2026-09-08, after the view-thinning pass)

- **Branch `master`, working tree clean.** Ahead of `origin/master` by the whole local history
  (GitHub `p-wegner/agentic-kanban`) — see "Next steps". The second remote `gitlab` points at
  `pizza-und-ai-code/agentic-code-review`, a DIFFERENT project, not a mirror.
- **Stable is `stable-20260908-2`, live on 3001.** Master is now WELL ahead of it — the whole
  #1062-#1068 epic landed after that promotion. **Nothing is live-verified on stable yet.**
- **EVERY suite green, whole-repo**, run to completion after the last commit:
  **server 894 files / 8823 tests**, **client 184 / 1758**, **shared 121 / 1187**,
  **mcp-server 44 / 208**, plus `pnpm check:arch` (50s) and `pnpm typecheck` (5 packages).
  The server run is the one that matters: it is what caught #1069, the nloc shrink and the
  whole-tree-walk timeout, none of which any targeted run touched.
- **Nine wire-DTO grandfathering entries banked** plus the `createIssuesRoute` nloc ceiling
  (463 -> 421) — shrink-only ratchets must be lowered or they become budgets.
- **Visually verified** on the dev board (`pnpm dev:devboard`, 5273) with playwright: the 13
  primary tabs, all 10 Analytics tabs and 3 Focus tabs rendering and switching, tab URLs, a cold
  deep link, all six legacy redirects, and the four deleted routes falling back to the board.
  0 console errors. This is what found the #1067 URL bug.
- **Board (agentic-kanban project): #1062-#1068 Done, #1069 open (Todo).**
- **The DEV board now has `agentic-kanban` registered** (its own DB,
  `~/.agentic-kanban-dev/kanban.db`) — added for that visual verification; harmless and useful
  to keep.

### Next steps, in order

1. **Promote.** Master is far ahead of `stable-20260908-2` and the pass is entirely
   board-UI, so the operated board still shows the OLD views until a promotion. `pnpm promote
   --dry-run` first; #1044/#1060 mean it will request its own sweep rather than dead-ending.
2. **Operator: decide the push.** Clean fast-forward to `origin/master`. The Linux CI run #923
   needs has still never happened — every sweep here is Windows-only. Not ours to decide.
3. **#1069** — the disclose-context hook dies once the Bash tool's cwd moves. Corrected
   diagnosis is on the ticket; the fix must preserve the relative spelling.
4. **#1070** — the registration scaffold regression above.

### Open, unexplained — chase this if it recurs

**The stable board died overnight on 2026-09-08 at 06:30 UTC.** Nothing listening on 3001/5173
when the session started. `.kanban/board.log` ends mid-cycle with **no error, no `[fatal]`, and no
shutdown line**; pid 24720 (started by the previous evening's recovery promotion) was simply gone.
Restarted headless on the same artifact and it has been healthy since. Not diagnosed — the log
around that timestamp is the evidence, and a silent death with no log line is the signature.

### Operator flag — RESOLVED, not open (corrected 2026-08-27)

`packages/server/kanban.db` does not exist; CLI and server both open
`C:\Users\pwegner\.agentic-kanban\kanban.db`. The `[db] opening ... (source: home-fallback)`
line is the NORMAL path, not a warning — do not re-file it as a defect.

## Archive

Passes older than 2026-09-08 have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so it records what each session believed at the time. Look there for the 2026-09-04..09-07 passes
(the profile-roster wave, the two-board split and `pnpm promote`'s first real runs, #1039, and the
three successive WRONG diagnoses of the #1046/#1048/#1049 gate failures — %TEMP%, then log
truncation, then #1059's sweeper, which is the correct one), the
2026-09-01/02 wave (#986/#992/#994/#995/#996/#997/#998/#999 and the verification-cadence pass), the
2026-08-25..28 waves (#924, #807, #903, #901, #857, #874, #887, #899/#898/#897, #894, #881, the
26-ticket direct-master batch, #859's root cause, the UI overflow sweep), and before them the #680
gate-hermeticity history, the "batch 1 of N" true-state table (#691), the 2026-08-21/22/23 waves,
the adversarial review, and the hook-cost investigations.
