# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.


## 2026-09-24 — review of the last landings, the #1228 gate loop, and the Yegge follow-ups

**Board restarted.** 3001 was down on session start (no exit record looked at; the dev board on
3101 was down too). `node scripts/promote.mjs --restart-stable` brought `stable-20260923`
(`461837706c`) back on pid 3856, smoke passed. Master is two landings ahead of it: #1229
(`01ef8a6cda`, plugin scripts stream progress over SSE) and #1227 (train `2026-09-24-01`,
Plugins view subroute). Both reviewed: shape is fine, nothing to fix before promotion.

**#1228 is the one open ticket and it was looping.** Its branch (`0f2e1546e7`) failed the
pre-merge gate **31 times between 22:47 and 06:49 UTC**, every run on the same deterministic
guard: `function-nloc-ratchet.test.ts`, because #1227 lowered `PluginViewsPanel` to 550 and the
overlay JSX pushes it over. The ledger rows all say `failed: []` (guards are not named), the
board log says only `verify_script failed (exit 1)`, and auto-merge re-gated it every tick
(the gap #1219's own comment admits: `shouldSkipMergeForBackoff` is not consulted for
`verify_failed`). Each run: arch 43 s + typecheck 19 s + tests 118 s. The same log shows
`impact selector failed to start (ENOENT)` although the selector file exists in the worktree, so
those gates ran `vitest related`, not the impact tier. Sent the builder a turn naming the guard
and asking for extraction, not a baseline bump; it is extracting (`PluginViewFrameHost.tsx`,
`usePluginViewFrameLifecycle.ts`) as this is written. The window holds it as `accumulating`.

**Filed #1230-#1236 (Backlog, tagged `no-auto-start` so the monitor waits for a human pick).**
The goal they serve: a merge pays only for what it touched, master may be red, the full suite
runs on master in the background and its misses feed back, promotion needs a green sweep or the
`--recover` lane. What the map showed (agent-verified, file:line in the tickets):
- **#1230** the `verify_failed` loop above: backoff, breaker for deterministic guard failures,
  guard names in the ledger row.
- **#1231** the base sweep spreads the board's `process.env` into the probe (`setup-script.ts:282`)
  and the 09-18/09-19 red rows carry selector-mode output; the verdict row does not record the
  mode it ran in, so a scoped green could promote. Also the selector ENOENT diagnostics.
- **#1232** the big lever: under `iterate` the merge-time floor is 171 unconditional
  `@gate:always-run` guards (`BASELINE_TOTAL_MS` 585 s) against a selection of ~2 files. Run only
  intersecting guards at merge time, defer the bare floor to the sweep.
- **#1233** `resolveBaseRedVeto` holds every train while the last sweep is red and master only
  moves through trains: a red sweep freezes the project. Under `iterate` `redBasePolicy` is
  `block`, so no heal ticket is filed either. Posture-aware veto + `allow-file-debt-ticket`.
- **#1234** the impact miss rate (#954 step 5) is still UNKNOWN; ledger rows carry no duration.
- **#1235** ten `kanban/train/*` worktrees since 09-14 kept forever by the reconciler.
- **#1236** ~~`cli.test.ts` is 643 s of a 60 min suite~~ — split into five `cli-<group>.test.ts`
  files on one esbuild-bundled CLI + template DBs (`helpers/cli-harness.ts`); measured 11-76 s
  each, ~230 s together (was 643 s). Still excluded from `test:mine` (child process per case),
  so `MAX_EXCLUSIONS` moved 10 → 14 for the same one suite.

**Current settings that matter for this** (read from `/api/preferences/settings`): posture
`iterate`, `verify_gate_strategy` = `impact`, `test_impact_budget` 120 s, `verify_max_workers` 2,
`verify_timeout_ms` 90 min, `merge_strategy` `merge_queue`, train window max 4 / 10 min, Start
Mode `monitor`, WIP 2, one start per cycle, sweep every 24 h (last green 2026-09-23 17:54 UTC on
`461837706c`, 35 min; next due 17:54 today).

**Untracked in the main checkout:** `.sentinel-issues.json` (3.6 MB, 2026-09-14, an issue
export from a sentinel run). Not ours to delete; not ignored either.

**Afternoon: #1228 landed (`1e05a1303e`, Done), after an incident worth reading before the next
review.** The auto-review session for #1228 followed the review brief's "`git rebase origin/master`"
(`review.service.ts:160,173`) while `origin/master` was five days stale (nothing pushes master to
GitHub), replayed 112 commits onto that base, then ran `git update-ref refs/heads/master
origin/master` and force-moved the SHARED master to `6ec1600622` (2026-09-19) at 09:19:48. The
main checkout then read as "262 uncommitted tracked changes", a plugin scaffold committed on the
wrong tip, and every merge refused (`dirty_main`, then "174 commits stale"). No guard fired: the
cross-worktree hook arms on paths, not on ref writes. Repaired by hand: `git update-ref
refs/heads/master ac8ef86f24 0a5bfae04f`, scaffold re-committed as `58a2926d4f`, the branch reset
to master and its final 7-file diff applied as one commit (`e321bc23d3`; the re-click guard now
reads through a ref so `selectView` stays stable for #1227's deep-link hook). Also fixed on the
way: the worktree's CRLF `.herdr/plugin/agentic-kanban-hooks.mjs` (the #1146 trap, `rm` + `git
checkout --`) and its stale impact map (rebuilt on main, copied in). Filed **#1237** (critical,
`no-auto-start`): review brief must name the local base, a worktree session may never write the
base ref, and a lagging remote base ref must be reported. `origin/master` is still at 09-19;
pushing it is the operator's call.

### Next steps, in order
1. `pnpm promote --dry-run`: #1227, #1228 and #1229 are on master, ahead of the 17:54 verdict, so
   it will trigger and wait for a sweep.
2. Pick from #1230-#1237. Suggested order: #1237, #1230 (stops the waste today), #1231 (makes the
   sweep trustworthy), #1233 + #1232 as a group (the actual Yegge workflow), #1234 (proves it),
   #1235, #1236. Remove the `no-auto-start` tag to hand one to the monitor.
3. Re-enable auto-merge on the three fixture projects paused 2026-09-20 for CPU.

### Verified by
`curl 127.0.0.1:3001/api/health` after the restart; `git diff --stat stable-20260923..master`
read in full; `.test-impact/outcomes.jsonl` has 31 rows for `0f2e1546e7`, all `fail` with
`failed: []`; the failing suite is in `%TEMP%\kanban-verify-75b824fe-…log` line 20; the seven
tickets answer `issue list` with the `no-auto-start` tag (`POST /api/issues/:id/tags` → 201).

## Archive

Passes older than today have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so each pass records what that session believed at the time. The archive
holds:
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
