# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.


## 2026-09-27 — merge mechanism repaired and live; handoff before a reboot

**Why the reboot.** After 19 h uptime about 10 GB of RAM sat in the Windows kernel pools (paged
7.0 GB, non-paged 3.4 GB; healthy is under 1-2 GB), committed memory 31.6 GB on 27.6 GB physical,
and Claude Code reaped background jobs twice. Suspected cause, not verified: filesystem churn from
test runs (`%TEMP%` ~114k entries) through Defender's filter and NTFS metadata. Diagnose with
Sysinternals RAMMap (pool tags) if it climbs again.

**State of the board.** Stable board runs `stable-20260927-2` (sha `4401279111`) on 3001, UI on
3001. Master is ahead of it by the landed tickets below (`0ccd6f87ad`+). Posture `flow` (set by a
Bullseye save 2026-09-26 20:04), WIP 4, `merge_strategy` `merge_queue`, auto-merge ON for
`agentic-kanban` (it was paused 2026-09-27 ~12:40-13:15 for the promotion and re-enabled; the
autopilot endpoint confirmed `enabled: true`). `train_max_wait_ms_<id>` = 120000.

**Landed 2026-09-26/27** (on master, verified by `git log`): #1245, #1246, #1247 (+ coupled #1248,
#1249), #1252, #1254, #1255, #1256, #1258, #1260, #1244 + #1262 (train `-07`), #1259 (train `-08`).
Cancelled: #1257 (a false alarm its own filer retracted; built only because I moved it to Todo by
mistake).

**Direct-master board fixes** (the user asked for fixes, not tickets), all on master and live in
`stable-20260927-2`:
- The same-failure breaker holds ONE branch, not the whole project; a red train logs its suites.
- A passed gate or train survives a base move that touches only verdict-neutral paths
  (`base-move-relevance.ts`; e.g. Bullseye `objective.md` syncs, `CONTINUE.md`).
- CLI issue writes go through the running server so the open board updates.
- The Delivery chip leads with the live merge state (`Merging train-NN · …`, `N ready`, `Last: …`).
- Train, bisect and control-arm worktrees get the test-impact selector and map. Before this every
  `flow` train gate fell back to `vitest related` (~950 files, 30-90 min); train `-07` took 13.5 min,
  `-08` 4.5 min.
- Train verify logs are real files (`%TEMP%\kanban-verify-train-train-<date>-N.log`); before, the `:`
  in the key wrote them into NTFS alternate data streams of an empty `kanban-verify-train` file.
- A train member dropped for a base conflict is sent back to its builder at once (cap 2, then a
  merge hold). Verified live: #1259 sent back from `-07`, landed in `-08`.
- Costly checks left the hooks: the board runs one implement-exit check per phase before review
  (`implementExitCheck`: strict full, standard/iterate/flow impact, fast typecheck, sprint none;
  ledger source `implement-exit`); Stop hooks are safety only; the stack-profile generator no
  longer emits a whole-suite Stop rule. The stale untracked `.claude/smart-hooks-rules.json` (full
  `test:mine` on Stop with a 180 s timeout) was deleted.
- `docs/integration-risk-ladder.md` now explains the whole strategy for a classical-CI reader: why
  agents move the bottleneck to integration, the three resources (compute, tokens, velocity), the
  merge queue and train, the release candidate as the place to heal, per-rung knobs, the resource
  side, the recovery mechanisms, and choosing a rung.

Verified by: full `typecheck` + `check:arch` + `gate:always-run` + full `test:mine` (0 failures) at
`e064d3b62f` and again at `4401279111` before each promotion; `pnpm promote --force-sweep` smoke
passed both times (`--force-sweep` deliberately, because the rc sweep could not finish on the old
code; those two full runs are the evidence).

### After the reboot, in order
1. `pnpm stable:start` from this checkout (restart-only door; it refuses if 3001 is held). Check
   `http://127.0.0.1:3001/health` and the Delivery chip.
2. The queue resumes by itself. #1253 and #1261 were rebased onto master by `update-base` at 13:50
   and should ride the next train; a train cut off by the reboot is reassembled by the reconciler.
   Watch `GET /api/merge-queue/trains?projectId=d1c5d9c1-4897-4e1b-acc3-2aa96de04117`.
3. Promote once they land: `pnpm promote --dry-run`, then `pnpm promote`. Under `flow` it cuts an
   rc and wants a full sweep; with #1256 live the sweep no longer yields to gates, so try without
   `--force-sweep` first.
4. Clean up: the four scratch worktrees `../ak-direct-{stop-hooks,phase-checks,train-rebase,train-selector}`
   and their `direct/*` branches are landed (fast-forwarded) and can go (`git worktree remove`);
   `.worktrees/agentic-kanban/scratch-train-repro` (detached, holds the BOM commit `34444859dd`)
   and ~9 locked `feature_*-msz8*` test worktrees are older leftovers for the `cleanup` skill.

### Open, not done
- A sided train member that becomes mergeable because master changed stays held until its own tip
  moves (seen on #1253/#1261; released by hand with `update-base`). Fix: re-check merge-tree against
  the current base before honouring the siding hold.
- Builders run vitest with 8 fork workers (seen on #1259's relaunch, ~1.9 GB); cap it like the gate.
- ~28k `agentic-*` entries in `%TEMP%` are not covered by any sweep script.
- The kernel-pool growth itself (see above).
- `direct-master/SKILL.md` still says a PostToolUse hook typechecks on every edit; it no longer does.
- Train `-06` went red on `verify-gate-runner.test.ts`, which passes on master and on every member
  branch; never explained (the train ran on the old fallback selection and was cancelled).
- Carried from 2026-09-26, untouched since: `git pull --ff-only` in the ki-team
  `refactor-safety-net` (GitLab answered HTTP 500) and then Update the plugin
  (`POST /api/plugins/d9eae2ad-…/update`); decide whether `reqextract` moves to
  `ki-team/software-modernization/reqextract`.


## Archive

Passes older than today have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so each pass records what that session believed at the time. The archive
holds:
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
