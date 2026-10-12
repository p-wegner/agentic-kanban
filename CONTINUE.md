# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-10-12 — backlog drive on the two workers; D: hangs traced to WSL disks on the Dev Drive

**Goal (Peter):** get the backlog done using desktop-stable and wsl-stable only (builders and
reviewers run on workers, `worker_dispatch_strict` on; gates still run on the laptop).

- **Stable:** `stable-20261012-2` = master 19b2329aa, promoted ~11:32Z (full sweep green).
  desktop-stable re-pinned to it (C:\Users\Peter\aks, 2 slots); wsl-stable auto-updated.
- **Merged today (19):** #1385 #1408 #1391 #1407 #1383 #1413 #1412 #1409 #1417 #1404 #1410 #1403
  #1415 #1411 #1420 #1419 #1418, plus #1395 #1400. Open, all built at least once: #1378 #1380 #1381
  #1382 #1384 #1392 #1405 #1406 #1414 #1416 (reviews, rebases or held gates). Decisions left to
  Peter: #1337, #1371.
- **D: hung three times** (writes+fsync never return, processes unkillable, only a reboot clears
  it; System log `vhdmp` 129 resets). D: is a Dev Drive VHDX (`C:\DevDrive\dev.vhdx`); the WSL
  worker distros lived in `D:\wsl-images` = a VHDX inside the VHDX, and every hang came while a WSL
  worker was busy. **Moved `akw-r6` to `C:\wsl-images\akw-r6`** (`wsl --manage --move` copied the
  file, then failed E_ACCESSDENIED on the registry; fixed `BasePath` in HKCU Lxss by hand). Since
  then: no hang through hours of gates and builds. Keep worker distros OFF D:. IT addendum (exclude
  the VHDX from MDE) in `Documents\performance\2026-10-11-kernel-pool-leak-for-IT.md`.
- **Recovery recipes used today:** a result in `refs/kanban/incoming/<branch>` that never reached
  the workspace branch (#1414) -> `ALLOW_CROSS_WORKTREE_WRITE=1 git -C <wt> reset --hard <incoming>`
  (clean worktree only), then POST review. A result the board refuses (401 after it ended the
  session) -> git bundle from the worker over ACP. A commit holding a path with `C:` (#1419) ->
  rebuild the tree in a temp index (`core.protectNTFS=false`, `update-index --force-remove --stdin`)
  and `commit-tree`. WSL login expired -> copy the main `.credentials.json` again (not read) into
  `~/.claude` and the harness dir. Corrupt worker clone -> move `state-work/repos/<project>` aside.
- **Filed today:** #1411 (strict dispatch drops reviews/send-backs/auto-starts when slots are
  full), #1412-#1420. #1420 (worker misses pongs after a push -> session finalized exit 1) and
  #1414 (late results never reach the branch) cost the most operator time.
- **Laptop limits:** gates run three at a time at ~3 GB each; implement-exit checks took up to
  ~30 min queued; Claude Code reaped background shells at < 2 GB free (the driver script survived,
  only its wrapper died). The scratchpad driver (`drive3.sh`) launches only at >= 4 GB free.

**Next:** land the open ten (watch gates; send each red back with the exact failing suite), then
check that #1414 makes the manual incoming->branch reset unnecessary; consider #1380 (gates on
workers) before the next large drive.

## Archive

Passes older than today have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so each pass records what that session believed at the time. The archive
holds:
- **2026-10-10 night (moved 2026-10-12):** tailnet rounds 3-7, newcomer install, #1356-#1366.
- **2026-10-10 evening, afternoon, later (moved 2026-10-11):** tailnet worker rounds 1-2, self-update
  hardening, the worktree race instrumentation, six local fleet e2e rounds, Tailscale prep (#1315-#1355).
- **2026-10-10 morning + 2026-10-06 (moved 2026-10-10 night):** #1312-#1314 Done and the board drained;
  lean builders measured, project hooks failing open in builders (#1311), #1310.
- **2026-10-04 afternoon (moved 2026-10-10):** after the reboot, `stable-20261004-8` live with #1295-#1299,
  #1302-#1305, #1307 and #1309; board empty.
- **2026-10-04 morning (moved 2026-10-06):** #1289/#1292/#1293 live, a red gate goes back to the builder.
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

## #1378 WSL worker dispatch — state
Done in repo: `scripts/fleet-firewall.ps1 -Wsl` (WSL vEthernet-scoped rules) + docs/worker-fleet.md.
Remaining, host-side (cannot be done from a builder checkout): bind listener for WSL; long-lived distro
(node 22, corepack pnpm, `agentic-kanban-worker setup`, labels `wsl,pnpm`, start at login); project
dispatch preference (remote preferred, local fallback, check `worker explain`); `pnpm test:mine` on Linux
and triage of failures; `.wslconfig` (memory > 6GB, move `autoMemoryReclaim` to `[experimental]`);
PoolMonX `Schc`/`File` before/after measurement (WSL vs Windows builder). No pool delta measured yet.
