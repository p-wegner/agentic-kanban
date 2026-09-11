# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-09-11 (evening) — `stable-20260911` promoted at `37e19756b6`; #1094 merged after it

**Stable runs `stable-20260911` = `37e19756b6`.** That commit includes #1087, #1089, #1090, #1092,
#1093, #1095 and #1096. The smoke test passed (health 200, 2 projects, board status answered);
the rollback target is `stable-20260910`. **#1094 (`a13dbaf2d0`) merged AFTER the promote and is
not live yet.** Master is at `a13dbaf2d0`.

**Why the promote needed a fresh sweep first.** The first dry run would have promoted
`7858da2470`, last night's swept sha, so none of today's work would have gone live. No sweep had
recorded all day: the base probe kept YIELDING its verify slot to queued merge gates, twice after
10+ minutes of work, 2 of 3 consecutive yields. What unblocked it: re-arm the
`auto_merge_disabled` kill switch so no gate queued, then join the running probe. It came back
green at the tip in ~14 min. The kill switch is **disarmed again** (`"false"`, verified).
**Lesson:** on a busy merge day, "promote" silently means "promote last night"; read the
dry run's `promote sha` line before running it for real.

**#1095 is live but NOT yet exercised.** #1094's gate ran `stage=verify` only, with no smoke
boot. The `[db] opening … (source: DB_URL)` line in the board log is the promoted board's own
start. The first gate that runs a smoke check on `stable-20260911` is the real verification: its
server must not resolve `~/.agentic-kanban/kanban.db`.

**Filed #1098 (medium, `no-auto-start`).** `recordGateOutcome` → `buildRecordArgs` passes
`--selected`/`--failed` comma-joined on the command line. A day-wide base sweep exceeds Windows'
32,767-char limit, fails `spawn ENAMETOOLONG`, and silently drops the base-sweep row from the
test-impact ledger (the #954 corpus). #967 moved only `select --union` to stdin. The fix needs the
test-impact tool's `record` to accept stdin lists too. That tool is its own repo, hence
`no-auto-start`.

**Open, in order:** #1097 (timeline remainder B, `no-auto-start`; #1096 has landed, so it may start
now), #1098. `chkdsk C: /f` is still the operator's. CONTINUE.md is far past its ~150-line cap;
an archive pass is due (move the 2026-09-10 and older passes).

## 2026-09-11 (later) — timeline reconciled (#1090 → #1093); the smoke check boots a second board on the OPERATED DB (#1095)

**Timeline is landed and the four overlapping branches are resolved.** Operator decision: land
#1090 first, then reconcile. The two merges were #1089 (Runners view, `1a6dde61ea`), then #1090
(`bb535143cc`). #1093 (`0bcc524416`) then ported what #1088 and #1091 had and #1090 lacked.
#1086/#1088/#1091 are **Cancelled as superseded**, each with a comment. Their workspaces and
branches are deleted; the commits survive at `refs/kanban/archive/ak-{1086,1088,1091}-2026-09-11`.
The auto-merge kill switch (`auto_merge_disabled_<agentic-kanban>`) was armed for the whole
sequence to enforce that order. It is **disarmed again** (`"false"`, verified).

**#1086 is NOT fully done: its remainder is carried forward, not dropped.** A read-only
classification at the #1093 tip found 5 of 36 findings done, 10 partial and 21 open.
- **#1096** (high): correctness. Most important, **P1-1 bar clipping was never wired in**:
  `clipSpan` exists and is tested but has no production caller. #1093 skipped P1-1 on MY ticket's
  false claim that #1090 covered it. The monitor started #1096.
- **#1097** (medium): UX / a11y / perf / polish. Tagged `no-auto-start`, because it edits the same
  two files as #1096. Start it after #1096 lands.

**#1095 (high, filed): the pre-merge smoke check is a hazard and hides its own errors.**
- `pre-merge-gate.service.ts:733` calls `runSmokeCheck` with no env, and `smoke-check.ts` spawns
  with `{...process.env}`. The smoke boot is a FULL board against `~/.agentic-kanban/kanban.db`:
  monitor loop, startup reconcilers, session reattach. The verify half has been isolated since
  #231; the smoke half never was.
- Its failure message uses the log HEAD (`slice(0, 400)`), which is always the pnpm notice plus
  the banner. Both #1090 (exited, code 1) and #1093 (60s timeout) were withheld with no visible
  cause. Both passed on a plain retry, i.e. environmental.
- **Tried and rejected: booting a worktree's `pnpm dev` by hand to diagnose it.** That does the
  same thing (home-fallback, operated DB): I got a second monitor cycle and a reattached live
  session for ~100s. No damage, only because the kill switch was armed and WIP was capped. Until
  #1095 lands, point `AGENTIC_KANBAN_DIR` at a temp dir if you must boot a worktree.

**Still not live:** nothing merged today (#1087, #1089, #1090, #1092, #1093) reaches the operated
board until `pnpm promote`. `chkdsk C: /f` is still the operator's.

## 2026-09-11 — merges stuck: a corrupt pnpm store, and a gate that could not say so (#1092)

**#1086/#1087 sat In Review with the merge parked.** Their pre-merge gate failed on
`depcruise` "konnte nicht gefunden werden", classified `verify_infra_missing`, and backed off 2h.
The code was never the problem. **Every worktree's `pnpm install -r` had failed**: the shared
store `~/.pnpm-store/v10` holds entries that are listed but cannot be stat'ed ("Die Datei oder
das Verzeichnis ist beschädigt"). That is NTFS damage — `chkdsk` is the real fix, and it is the
operator's to run. Worked around by quarantining the affected shards
(`files-<xx>-corrupt-2026-09-11`), which makes pnpm re-fetch them.

**#1092 (landed here, direct on master) makes the next occurrence visible:**
- #169's install retry now recognises German cmd.exe "command not found".
- Gate summaries drop pnpm's `"pnpm" field` deprecation notice, which had headlined every failure.
- A failed PARALLEL setup now emits the butler `workspace_error` event, naming the real
  `ERR_PNPM_*` line (`setupFailureHeadline`).

Verified: the two changed test files (30/30), server `tsc`, `pnpm check:arch`.

`pnpm gate:always-run` came back **1198/1200**:
- `function-nloc-ratchet` was mine: `createWorkspaceCreateService` grew 644 → 654. It is fixed in
  `567add1cf8` (notification moved to a module-level helper) and re-verified.
- `legacy-temp-prefixes` timed out at 300s under load: installs plus 4 gate workers, with
  `%TEMP%` at ~78k entries. Run alone it passes in 10s.

The full gate was NOT re-run after the fix. Say so rather than imply it.

**Not done, and not solved by #1092:** the stable board runs `stable-20260910`, so none of this is
live until `pnpm promote`. A worktree whose setup failed still needs its install re-run by hand.

## Where this stands (2026-09-11)

**Read this section before the dated passes above.** Each dated pass describes the state at the
time it was written. Standing state lives here.

### Verified now (2026-09-11, evening)

- **Branch `master`, working tree clean.** It is **78 commits ahead of `origin/master`** (GitHub
  `p-wegner/agentic-kanban`) per the local `origin/master` ref, which was last updated 2026-09-08,
  and 0 behind. Nothing from 2026-09-08 onward is pushed. The `gitlab` remote points at
  `pizza-und-ai-code/agentic-code-review`, a DIFFERENT project, not a mirror.
- **Stable is `stable-20260911` = `37e19756b6`, live on 3001.** The promote smoke test passed.
  Rollback target: `stable-20260910`. Master is ahead of it by #1094 (`a13dbaf2d0`) plus docs
  commits.
- **Last full base sweep: green at `37e19756b6`** (2026-09-11 16:13 UTC). It is the sweep that
  authorized the promotion.
- **Board (agentic-kanban): two open tickets, both tagged `no-auto-start`.**
  - **#1097**: timeline remainder B. Its prerequisite #1096 has landed, so it may start; remove the
    tag to let the monitor take it.
  - **#1098**: test-impact `record` fails with `ENAMETOOLONG`. It needs the test-impact tool (its
    own repo) to accept stdin lists first.
  - #1069 and #1070 from the previous standing list are Done.
- **Auto-merge kill switch** `auto_merge_disabled_d1c5d9c1-…` = `"false"` (verified after the
  #1094 merge).

### Next steps, in order

1. **Verify #1095 live.** The first gate on `stable-20260911` that reaches the smoke stage must
   boot its server on a throwaway data dir, not `~/.agentic-kanban/kanban.db`. #1094's gate ran
   verify only, so this is still unobserved.
2. **#1097**: remove `no-auto-start` when the timeline work should continue.
3. **#1098**: file or make the tool-side stdin change in the test-impact tool's repo, then the
   board half.
4. **Operator: decide the push** (78 commits, fast-forward). The Linux CI run is still unrun;
   every sweep here is Windows-only.
5. **Operator: run `chkdsk C: /f`** (admin, reboot). The pnpm store's corrupt shards are
   quarantined as `files-<xx>-corrupt-2026-09-11`, not repaired.

### Open, unexplained — chase this if it recurs

**The stable board died silently on 2026-09-08 at 06:30 UTC**: no error, no `[fatal]`, no
shutdown line (details in the archived 2026-09-08 pass). It has not recurred since. It stayed up
through this whole session until `pnpm promote` restarted it deliberately.

### Which `[db] opening` line is normal

The stable board logs `[db] opening C:\Users\pwegner\.agentic-kanban\kanban.db (source: DB_URL)`;
that is expected. A **worktree** server logging the same file with `(source: home-fallback)` has
reached the operated DB. That is the #1095 hazard, not a normal path. The old "home-fallback is
normal" flag (archived) predates the two-board split.

## Archive

Passes older than 2026-09-11 have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so each pass records what that session believed at the time. The archive
holds:
- **2026-09-08..09-10:** the overnight board death and #1056, the target-only drive scope fix
  (#1071-#1073), the NTFS pnpm store corruption behind `verify_infra_missing`, the Jira-epic
  passes, #1085 and the monitor race, and the stale 2026-09-08 standing section.
- **2026-09-04..09-07:** the profile-roster wave, the two-board split and `pnpm promote`'s first
  real runs, #1039, and the three successive WRONG diagnoses of the #1046/#1048/#1049 gate
  failures (%TEMP%, then log truncation, then #1059's sweeper, which is the correct one).
- **2026-09-01/02:** #986/#992/#994/#995/#996/#997/#998/#999 and the verification-cadence pass.
- **2026-08-25..28:** #924, #807, #903, #901, #857, #874, #887, #899/#898/#897, #894, #881, the
  26-ticket direct-master batch, #859's root cause, and the UI overflow sweep.
- **Earlier:** the #680 gate-hermeticity history, the "batch 1 of N" true-state table (#691), the
  2026-08-21/22/23 waves, the adversarial review, and the hook-cost investigations.
