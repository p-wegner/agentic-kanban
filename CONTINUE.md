# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-10-04 — #1289/#1292/#1293 live, a red gate goes back to the builder, master pushed

**State.** Stable board runs `stable-20261004-2` (`98d5d2156`), promoted by `pnpm promote` on a
full green sweep of `rc/20261004-2`; `origin/master` = `master` = `98d5d2156`. Board: no
agentic-kanban ticket open except #1290 (owner's placeholder, `no-auto-start`).

- **#1289** path comparisons resolve junctions (`pathKey`), so a project registered via
  `C:\projects\…` (a junction to `D:\…`) no longer logs false RECONCILE warnings.
- **#1292** unlisted projects get no train or base probe; the red-base hold logs once per change.
  Check: 0 `base_red … c94e30c4` lines in 3 min on the promoted board (was ~2/min, 10,642 total).
- **#1293** a red pre-merge gate that names failing suites sends the builder ONE feedback turn per
  branch head (cap 2, then the old escalation); infra reds get none; never a merge path (#638).
  Not yet seen live on a real red gate; the first one is its proof.
- **Direct fix** `c7a4c31c8` + `449976d2d`: `planRcCandidate` abandons an rc that diverged from
  the stable HEAD (the pre-rewrite `rc/20261002` blocked every promote). #1294 is its Done
  record. `449976d2d` repaired the `.d.mts` declaration that `c7a4c31c8` forgot (server
  typecheck was red on master for ~10 min).
- **Second local rewrite before the push:** a #1289 code comment named the organisation in an
  example path. Only `origin/master..master` (16 commits) plus `stable-20261004*` and
  `rc/20261004*` were rewritten (`filter-repo --refs ^origin/master …`); the stable worktree
  moved to the new `stable-20261004-2`. Refs before: `D:\backup\refs-before-push-2026-10-04.txt`.
  **Scan only the range you push** (`log -p origin/master..master` + identities): old local rc
  and feature branches still hold pre-rewrite history and make an all-refs scan red.
- **Defender pool leak** (box-level, not the board): it grows with files opened for the FIRST
  time on C: (0.24 entries per file; 0.02 on the Dev Drive). The idle board is at 44–76/min.
  Full write-up outside the repo.

**Next:** watch the first real red pre-merge gate: the builder must get the turn without a human.

## 2026-10-03 — history rewritten; every commit hash before today changed

**State.** The whole history was rewritten (`git filter-repo`) to remove confidential terms that
had been public on GitHub. Local and `origin` are the SAME rewritten history (`master`
`06c9ce4a6`). **Every hash quoted in this file, the docs, tickets and the board DB from before
2026-10-03 refers to the old history and no longer resolves**; look commits up by subject or
date. Tags kept their names (`stable-20261003` = the old `04dcb2a9d1` content). Old history:
backup `D:\backup\agentic-kanban-git-2026-10-03` and the `gitlab` remote (archive: never push
there, never merge from it). Repo-local `user.email` is now the GitHub noreply address.

- **Board DB keeps the old hashes**; checked that every consumer fails safe (skips, refuses or
  re-probes). Consequence: `pnpm promote` needs a fresh sweep (`--dry-run` first).
- **Remote fleet worker clones** hold the old history: re-clone.
- **Stable board** (`../agentic-kanban-stable`) is a worktree of this repo, moved to the
  rewritten `stable-20261003`; its built artifact is unchanged. Board servers are stopped.
- **Tests:** typecheck green; `test:mine` full scope green (657 s, TEMP on `D:\tmp`). The
  Dev Drive TEMP exposed a real `vital-file-guard` bug: `VITAL_FILES` was split on every `:`,
  so a `D:\…` vital file became the bare entry `D`, which matched any command containing a
  "d" and the real file was never backed up. Fixed in both copies, with a regression test.
- Four tests the rewrite broke were repaired (`48103e48c`, `06c9ce4a6`).

## Archive

Passes older than today have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so each pass records what that session believed at the time. The archive
holds:
- **2026-09-27 afternoon (moved 2026-10-04):** ten direct fixes on an empty board, the
  supersession rule for a stuck rc, `stable-20260927-4`/`-5`.
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
