# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-10-10 — board drained: #1312, #1313, #1314 Done

**State.** Stable board runs `stable-20261010` (`cf5f7bda2`, full green sweep of `rc/20261010`,
promoted 2026-10-10, smoke passed), carrying #1312, #1313 and #1314. `master` is NOT pushed.
Board: no open agentic-kanban ticket.

- **#1312 merged** (lean Claude builder profile). Its first gate run had died with exit 130;
  the re-run was first refused by a dirty main checkout, then went green.
- **#1313 merged** (root CLAUDE.md slimmed for builders, operator material moved to
  `docs/agent-guide/operator-reference.md`, budget guard). Gate was red on
  `always-run-guard-runtime-ratchet`: the new guard counted at the assumed 3,000 ms. Fixed by
  banking its measured 3 ms in `docs/tests/durations.json`; neither limit moved.
- **#1314 (direct fix)** `workspace start --project <name>` sent the name as `projectId`; now
  resolved via `resolveProjectIdArg`. Check: a name resolves to the id, an unknown name errors.

**Next:** scrub against the confidential-terms list and push master.

## 2026-10-06 — lean builders measured; project hooks were failing open in builders

**State.** Stable board runs `stable-20261006` (`7b271da82`, full green sweep of `rc/20261006`,
promoted 2026-10-06), carrying #1310 and #1311. `master` was pushed after this pass.

- **#1311 (direct fix, critical) — every project hook failed OPEN in headless builders.**
  `claude -p` on Windows runs hook commands through PowerShell, which reads a bare
  `$CLAUDE_PROJECT_DIR` as an undefined variable. smart-hooks-runner (command safety), the
  #959 cross-worktree guard, require-read-before-write and the Stop checks all
  MODULE_NOT_FOUND'd with a non-blocking exit. Fix: `${CLAUDE_PROJECT_DIR}/` everywhere; the
  scaffold heals old entries in place. Check: probe worktree with `KANBAN_WORKTREE_DIR`, write
  into main → created with the old spelling, `Cross-worktree write blocked` with the new; 3
  suites 77/77, typecheck clean. Live in `stable-20261006`.
- **#1310 (board builder, merged)** — Codex builders isolated via `-c` overrides; builder's
  live check: prompt 30,232 → 9,893 chars, user skills 17 → 0.
- **Lean Claude builder levers measured** (lean base 40.0k first-request tokens): auto-memory
  off −7.8k (builders also load the operator's private MEMORY.md), tool trim −5.0k, non-core
  skills name-only −2.4k, claude.ai connectors off −1.7k → combined 23.1k (−42%). Skills fully
  off makes it BIGGER (the Workflow tool inlines its guide). Filed **#1312** (lean profile
  with per-project add-backs) and **#1313** (slim CLAUDE.md for builders, −7.0k measured).

**Next:** scrub against the confidential-terms list and push master; then
let a builder take #1312.

## 2026-10-04 afternoon — after the reboot: stable-20261004-8 live, board empty

**State.** Stable board runs `stable-20261004-8` (`806b6a164` = `master` = `origin/master`),
which carries #1295–#1299, #1302–#1305, #1307 and #1309 (`-4` … `-7` went live earlier the same
day). Each push range was scrubbed against the confidential-terms list (0 hits; the parse was
checked against a known term first). Board: no open agentic-kanban ticket.

- **The unexplained "all passed, exit 1" sweeps were a crashing vitest worker.** First red with
  #1303's log (rc/20261004-6): `[vitest-pool]: Worker forks emitted error … Worker exited
  unexpectedly`, server 1025 + 1 skipped of 1027, `project-relocate.service.test.ts` never
  reported (passes alone 3/3; no board kill in the window). Seen again locally in 2 of 3 full
  server runs, then 0 of 2 with a JSON reporter: intermittent, cause still unknown.
- **#1309** a crashed worker no longer reds a sweep blindly: `verify-unreported-suites.ts` names
  the file(s) it never reported (vitest's own summary count, the per-file lines, and `vitest list
  --filesOnly` with the run's excludes must agree exactly, else no answer), and the existing flake
  retry re-runs them once. The crash lead line now sums every package summary through ANSI codes
  and names vitest's worker error, not an app `unhandled error` log line. Check: real sweep log →
  exactly `project-relocate.service.test.ts`; a log without per-file lines → none.
- **#1307** isolated builders get `--effort medium --autocompact 500000` (per-project prefs
  `builder_effort_<id>`, `builder_autocompact_<id>`); `inherit` passes only explicit prefs.
  Check: a real `claude -p` accepts the full flag set.
- Open thread, no ticket: the gate's own flake retry (#894) has the same blind spot for a worker
  crash; and `test:mine`'s impact selector resolves to a bogus `D:\repo\…` path and falls back to
  `vitest related` on every run.

- **#1302** (board builder, merged): per-project `builder_context_<projectId>`, default
  `isolated` = `--setting-sources project,local`. Verified by hand with headless runs: skills
  123 → 91, user skills and user SessionStart hooks gone, project PreToolUse/Stop hooks still
  run (debug log). Gap: `effortLevel`/`autoCompactWindow` came from user settings and no longer
  reach builders; not pinned explicitly (no ticket yet).
- **#1299** (board builder, merged): a review-exit gate red is stored per head as a
  `gate-decision` comment and the #932 reconciler will not arm that head; a `check:arch` red
  names its files so #1293 sends the builder one turn.
- **Deleted #1285–#1288, #1291:** `cli-issue.test.ts` fixtures that leaked into the real DB on
  2026-10-03 17:07 UTC. Current code does not leak: the suite (29/29) left the DB count unchanged.

- **#1306 closed, a real red, healed on the candidate.** `rc/20261004-4` failed `check:arch` in
  20 s: #1303 had pushed `base-branch-health.service.ts` to 1023 lines, over the god-module
  ceiling (unit tests and `tsc` were run before that commit, `check:arch` was not). The red
  verdict logic moved to `base-branch-red-outcome.ts` (service 868 lines, re-exports kept);
  the rc was fast-forwarded to that commit, swept green and promoted.

- **#1300 closed, no code change.** Two board sweeps of `rc/20261004-3` (12:37 and 13:35 UTC)
  went red with every visible suite passing and `failedSuites: null`. Not memory: 11–14 GB were
  free both times. Both ran beside an active builder. The same sha was green three times: in
  a worktree, as a faithful single-branch clone with `buildBaseProbeEnv` (887 s), and in a
  third board sweep on a quiet box. The cause of the two reds is unknown, because the sweep
  threw its evidence away (next item). If a sweep goes red again, read its log first.
- **#1303** a red sweep stored only `tail(stderr + stdout, 40)`, i.e. the end of stdout, while
  `test:mine` writes its verdict to stderr. It now goes through `summarizeVerifyFailure`
  (full log `<tmp>/kanban-verify-base-health-<project>-<branch>.log`, named in the
  `[full verify log: …]` trailer) and leads with the last 15 stderr lines. Check: new case in
  `base-branch-health-flake-retry.test.ts` (9/9 green); server `tsc` clean.
- **#1304** `runPluginCommand`'s timeout killed `cmd.exe` before `taskkill /T` walked its
  children, so the grandchild lived on. Every `plugin-exec-progress.test.ts` run left a `node
  hang.mjs` behind. Check: new tree-kill test fails on the old order and passes on the fix.
- **#1305** `pnpm promote` hung in `pnpm install` when the lockfile changed. On Windows the
  running board holds libsql's native module and the Agent SDK's `claude.exe` open inside
  `node_modules`, and the modules purge waits on them forever (11 min idle today, old board
  `degraded`, unblocked by stopping both by hand). `deployRef` now stops the board first.
  Check: `--dry-run` + promote-plan tests (88/88). Not yet seen live: the next promotion that
  changes the lockfile is its proof.
- **#1302 filed:** lean, controlled context for Claude Code builders. Today every builder
  inherits the user scope (ACP and Herdr hooks, user CLAUDE.md, ~20 user skills), because
  `--settings` adds to `~/.claude/settings.json` instead of replacing it.
- **Box:** Fast Startup is off, so a shutdown frees the Defender kernel-pool leak. Nonpaged pool
  was already 1.9 GB about an hour after the reboot.

**Next:** watch the first real red pre-merge gate (#1293: the builder must get the turn without
a human); the first red sweep on `-5` should name its cause via the #1303 log.

## Archive

Passes older than today have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so each pass records what that session believed at the time. The archive
holds:
- **2026-10-03 (moved 2026-10-04 evening):** the history rewrite; every commit hash before 2026-10-03
  changed (look commits up by subject or date), board DB keeps old hashes, fleet workers must re-clone.
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
