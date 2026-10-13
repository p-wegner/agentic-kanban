# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-10-13 — compute moved to workers; stable-20261013-3 live

**Goal (Peter):** every compute-heavy job of ticket work runs on fleet workers; the laptop only
coordinates. Also: get the backlog done on desktop-stable and wsl-stable.

- **Stable:** `stable-20261013-3` = master a2fd52f31, promoted ~17:10Z (rc/20261013-2 swept green
  on the re-run; the first sweep was red only on a vitest worker fork exiting, all tests passed,
  and master at the same sha swept green twice). Rollback target `stable-20261013-2`.
- **Verify placement ON (17:15Z):** `verify_placement_<agentic-kanban>=prefer-worker`,
  `verify_workers_<agentic-kanban>=desktop-stable`. Gates, implement-exit/review-exit checks, train
  staging, rc sweeps and base-health probes go to desktop-stable once it runs -3 (re-pin requested
  over ACP); otherwise they fall back to the host. Check: board.log names the worker on the next
  gate. Not yet verified live.
- **Merged today (24):** #1428 #1429 #1430 #1431 #1432(a) #1433 #1434 #1435 #1436 #1437 #1438
  #1439 #1440 #1441 #1442 #1443 #1445 #1446 plus the rc heal. Open: #1444 (rebase conflict with
  #1443/#1445 in worker.ts, back with a builder), #1447 (dev servers on workers via a board proxy,
  part b of #1432, building).
- **desktop-stable:** maxConcurrency is board-controlled now (start flag removed; desired 3 while
  Peter's own work leaves ~4 GB free on that box, 4 when it has room). Stale workers
  AO-PF38Z8R8 and monitor-local unregistered.
- **WSL login keeps expiring (4x):** a copied laptop `.credentials.json` dies at its access-token
  expiry after the laptop rotates the refresh token (proven by timestamps 13:56/14:00). Durable
  fix pending Peter: `claude setup-token` or a WSL `/login`. Until then re-copy (unread).
- **Recovery recipe used 5x today, now automated by #1446 (live from -3):** a worker push refused
  as `[stale but clean rebase]` -> verify incoming = base + own `(#N)` commits -> reset the worktree
  to `refs/kanban/incoming/...` -> POST /merge (scratchpad `adopt.cjs`). Reviewers rebasing a
  stale branch caused it every time.
- **acp:** backlog pass by an agent in herdr pane w1:p5Q, 7 commits pushed. `acp show/history`
  need an elevated hub restart (`service.ps1 -Restart`), pending Peter. Its open questions are in
  acp's BACKLOG.md.

**Next:** confirm the first gate runs on desktop-stable after its re-pin (board.log names the
worker); land #1444 and #1447; give the WSL worker its own login; restart the ACP hub.

## Archive

Passes older than today have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so each pass records what that session believed at the time. The archive
holds:
- **2026-10-11 (moved 2026-10-12):** harness provisioning rounds 0-6 and D3-D5 (goal reached), the
  first D: hang, #1367-#1402.
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
