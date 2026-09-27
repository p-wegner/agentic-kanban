# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-09-27 afternoon — board empty, ten direct fixes, promoted as stable-20260927-4

**State.** Every agentic-kanban ticket is Done; none open. #1253 and #1261 landed in train
`2026-09-27-11` (1 gate run) after `-10` went red. Stable board runs `stable-20260927-4` (`de111e6c5f`, master's tip as of this pass),
promoted 14:13 UTC by `pnpm promote` WITHOUT `--force-sweep` (rc `rc/20260927-2`, full green sweep,
smoke passed; no merge-back, since the rc held nothing beyond master). `stable-20260927-3` (`738ddc0307`)
went out at 13:19 the same way; the stuck `rc/20260926` was abandoned by the supersession rule below.
Posture `flow`, WIP 4, auto-merge on.

**Direct-master fixes (the user asked for fixes, not tickets), each with its check:**
- **#1261's mirror** (on its branch, `a11f2e02e9`): the server budget-cap mirror lacked #1262's
  1 s per-suite floor, so its lockstep test went red in `-10`. Landed with the train.
- **Test-reaper killed live fixtures** (`b55093d6ef`): every server vitest run's setup/teardown
  sweep killed any parentless process naming a fixture temp dir, however young.
  `verify-gate-runner.test.ts`'s #172 case detaches a listener on purpose, so any concurrent server
  run killed it. This was train `-06`'s unexplained red AND `-10`'s red control arm on a green
  master. Now spared while the dir is < 10 min old. Check: `fixture-orphan-namespace-reap` +
  `verify-gate-runner` green.
- **Suite-owner shortcut** (`061505c321`): a red train whose failing suites all belong to one member
  rejects that member and re-gates the rest once, instead of control arm + halving. Check: table
  test + a real-git train test showing 2 gate runs.
- **Siding re-probe** (`19ca652c73`, migration 0159 `workspace_train_siding.kind`): a CONFLICT siding
  whose tip has not moved is released once `git merge-tree` says it merges cleanly onto the current
  base (#1253/#1261 needed a hand `update-base`). Review sidings stay tip-keyed. Check: siding suite.
- **Builder vitest cap** (`9ffda28e83`): builders now get `VITEST_MAX_WORKERS` as well (the impact
  selector's printed `pnpm exec vitest run` line bypassed `KANBAN_TEST_MAX_WORKERS`); ceiling 8 -> 4.
- **Control-arm worktree** (`128b32947d`): `<label>-base` is attributed to its train row (was
  logged as an orphan, and never reaped after a crash).
- **%TEMP%** (`3a4e2b7b17`): `sweep-loose-test-db-files.mjs` also removes `agentic-kanban-vitest-<pid>.db*`
  (dead pid, > 1 h). Ran it: 26,709 files removed, %TEMP% 114k -> 88k entries.
- **Stuck release candidate** (`738ddc0307`): `rc/20260926` sat `sweeping` on a timed-out sweep after
  two `--force-sweep` promotions moved stable past it; every `pnpm promote` reused it and refused it.
  A candidate the stable board already contains is now abandoned and a fresh one cut.
- **Empty merge-back** (`b24ae9bd30`): after a promotion whose rc healed nothing (rc tip already in
  master), `promote` still asked the board for a merge-back; the board launched a builder into the
  zero-commit workspace (#1263: plan mode, no plan, blocked, relaunched). `promote` now skips it (exercised live on `-4`).
  #1263 itself was closed with the board's `reconcile-as-done` (`adoptMainCheckout`, rc tip = master).
- **update-base killed its own gate** (`18c97f912c`): #1263's merge gate went red on a tree that
  had just swept green. Master moved mid-gate, the monitor's pre-relaunch rebase ran `update-base`,
  and its process kill took down the gate's server vitest (no summary, exit 1). `updateBase` now
  refuses while the workspace's merge job runs (the job's own #1169 rebase passes `fromMergeJob`),
  and the monitor's rebase honours `no-auto-start` like its launch. Check: new refusal test +
  workspace-merge/monitor suites.
- `direct-master` skill no longer claims a hook typechecks on edit (`f1e4059e31`).

Verified before landing: `typecheck`, `check:arch`, `gate:always-run` green; 394 tests across the
touched suites; drizzle snapshot baseline. The rc sweep for the promotion is the full-suite check.

### Open, not done
- **Kernel-pool growth**: non-paged pool 1.9 GB and paged 1.8 GB only 30 min after boot (19 h
  earlier: 3.4 / 7.0 GB). No pool-tag tool on the box; attributing it needs Sysinternals RAMMap or
  poolmon installed (a user decision).
- Stale siding rows: `GET /api/merge-queue/trains` lists ~11 `workspace_train_siding` rows from
  2026-09-18..27 with `sidedBranchSha: null` (released, never cleared because the member never
  landed through the train). Cosmetic in the panel; nothing holds on them.
- ~18k `ak-*`/`kanban-*` fixture dirs in %TEMP% are "not yet stale enough" for the reaper; the
  `.worktrees/agentic-kanban/scratch-train-repro` and ~9 locked `feature_*-msz8*` test worktrees are
  still for the `cleanup` skill.
- Carried from 2026-09-26: `git pull --ff-only` in the ki-team `refactor-safety-net` then Update the
  plugin; decide whether `reqextract` moves to `ki-team/software-modernization/reqextract`.

## Archive

Passes older than today have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so each pass records what that session believed at the time. The archive
holds:
- **2026-09-27 morning (moved 2026-09-27 afternoon):** the merge mechanism repair (breaker, neutral
  base moves, train selector, train logs, send-back, phase-exit checks) and the pre-reboot handoff.
- **2026-09-26 (moved 2026-09-27):** the CLAUDE.md token pass, #1251 plugin skill listings, the
  `refactor-safety-net` plugin re-pointed to the ki-team checkout.
- **2026-09-24/25 (moved 2026-09-26):** the #1228 gate loop and the rebase-onto-stale-origin incident,
  #1230-#1236, master's red sweep fix, and the `stable-20260925` bootstrap promotion via `--recover`.
- **2026-09-21 evening + 2026-09-22 (moved 2026-09-24):** the stranded set landing (#1146, #1183,
  #1120/#1150/#1152), the six overnight monitor landings, #1219-#1221, `stable-20260922-2`, and the
  `promote.mjs` unknown-flag incident (fixed by #1222).
- **2026-09-21 morning (moved 2026-09-22):** the overnight train sweep — master red under the
  trains (#1214's boundary violation), seven landings, `stable-20260921` promoted.
- **2026-09-18/19 (moved 2026-09-21):** the sentinel-lab fold, #1199's identity finding (resolved
  2026-09-20 by unsetting the repo-local `[user]`), #1196-#1198 and the six train branches landing,
  and the stale `## Where this stands (2026-09-13)` standing section.
- **2026-09-17/18 (moved 2026-09-18):** the per-branch passes for #1191, the #1194+#1192
  integration proof, #1194, #1192 and #1193 — written while each was a branch, superseded by
  the landing pass above.
- **2026-09-11..09-12:** the #1102 Autopilot-chip pass, `stable-20260911`, the timeline
  reconciliation (#1090 → #1093), the first pnpm-store corruption (#1092), and the stale
  `## Where this stands (2026-09-11)` standing section.
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
