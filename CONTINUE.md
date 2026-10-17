# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

**Operating the board (any state check, idle/stuck board, workers, profiles, posture, reboot,
promote): read `docs/agent-guide/operator-reference.md` first.** Full console:
`pnpm cli -- status --watch`. This line is standing; keep it when passes are archived.

## #1569 train shepherd: PHASE 1 landed, remaining phases open (#691)

Done: brief carries each member's title/description/changed files (later turns omit them);
infra failure (disconnect/launch/zero-token) re-places the turn without consuming it, bounded by
`SHEPHERD_MAX_INFRA_RETRIES`, then the attempt is `agent_fix_held` (not red); a red train no
member owns messages NO builder; `TrainShepherd` + `mergeMembersWithShepherd`
(`merge-train-shepherd.ts`) are the tested session-reuse and conflict-resolution orchestration.
**Not done (follow-up ticket #1572):** (1) incremental assembly (worktree at window
open, merge per member) and calling `mergeMembersWithShepherd` from `assembleMergeTrain`/
`merge-train-worktrees.ts` instead of `deferred`; (2) wiring the red gate through one shared
`TrainShepherd.runner` (today `runAgentFix` still gets the raw runner, `resumeSessionId` is passed
but the default one-shot runner ignores it); (3) a real placed-session runner reporting usage so
the cost cap bites; (4) the held outcome in `merge-queue-train.ts` (at the 1000-line ceiling,
needs an extraction first) plus the one attention line; (5) shepherd line in `status --watch`.

## 2026-10-17 morning: host rebooted 10:01 local, board back

- `pnpm stable:start` brought `stable-20261017-2` back (smoke passed). All three workers online;
  wsl-stable started by hand in herdr pane w1:p5Y, console (`status --watch`) in w1:p5Z.
  Reboot runbook and which view is the full one: `docs/agent-guide/operator-reference.md`
  "After a host reboot".
- wsl-stable updated to a15f90a via `pnpm cli -- worker update <name>` (board side, no ACP needed).
- **Hands-off since ~08:50Z:** `start_mode=monitor`, `risk_posture=sprint` on agentic-kanban;
  leftover overrides (train size 5, wait 2 min, gate `impact`) cleared 11:2xZ, see #1560
  (was manual/standard; revert both to go back). Recipe: operator-reference "Hands-off".
- #1551 (worker restart after self-update hangs before connecting) filed from desktop-stable,
  back online on a15f90a after a manual restart (by 09:13Z); the monitor auto-started #1551.
- #1550 (tracker header shows no counts with 0 active issues) building on ao-pf38. #1549 cancelled
  as a duplicate of `status --watch`.

## 2026-10-17: UX probe landed, stable-20261017-2 live

**Goal (Peter):** a subagent explores the UI and fixes UX flaws; the board implements the rest.
**Done:** 0 open tickets (01:16Z).

- **Master = origin = dea3a44f2. Stable = `stable-20261017-2` = dea3a44f2** (promoted 01:15Z; smoke
  passed; rollback target `stable-20261017`). It carries #1548: the promote now accepts a green full
  sweep of the rc sha recorded under master, and did so on its first run (no second sweep).
- **UX probe** (subagent, playwright on the stable board): 8 client fixes committed direct
  (#1531-#1538: dark-mode text and Cancel button, phone toolbar row, Completed grid clipping,
  search chip "N matches", shortcut "/" separator, Escape on Merge Queue panel and phone
  Completed sheet). Screenshots in the session scratchpad `ux/`. **Not browser-verified:**
  Escape on both panels and the "/" separator (host RAM too tight for the dev board).
- **Board-built follow-ups:** #1539 (diff of a merged workspace with a deleted branch: 404, not
  500), #1540+#1541 (Completed grid pages Done/Cancelled server-side, Load more, server search),
  #1542 (every incoming-ref landing path adopts a clean rebase), #1543 (missing-deps retry ignores
  captured test output), #1544 (verify_result names failing suites), #1545 (a follow-up turn
  clears readyForMerge), #1546 (static tier now covers nloc, openapi drift, client fetch and
  validation ratchets; logs its verdict), #1547 (partial-work detector no longer trips on the
  noun "follow-up"). All landed through trains 10-16-09, -11, -12 plus one direct merge.
- **Lesson:** launching a review by hand right after a builder exits cancels its implement-exit
  check; #1541's ratchet breaks then cost a 39-min red train (train 10, cancelled). Let
  implement-exit start the review. A builder that ran on the HOST (not a worker) got no
  implement-exit at all with `auto_monitor` off; that one needed a manual review.
- **Verifiers:** `verify_workers = desktop-stable,ao-pf38`.
  - ao-pf38: Peter rebooted it 23:21 local; FMfn leak reset to 71 MB but grows ~430 MB/h under
    verify load. It needs a reboot every day or two until the leaking minifilter is found
    (`fltmc instances` as admin, Peter's step).
  - desktop-stable: Defender exclusions for `akswork`, the pnpm store and kanban fixture temp
    dirs still Peter's call.
  - wsl-stable: never for verify (shares host RAM).
- **Host memory** 3-4 GB free; background shells get reaped. Promotes run in herdr pane w1:p5W.

**Next:**
1. Peter: find the leaking minifilter on ao-pf38 (`fltmc instances` as admin); until then reboot it
   every day or two.
2. Peter: decide Defender exclusions on desktop-stable.

Verified on the live board 2026-10-17 (playwright, isolated session): Escape closes the Merge
Queue panel and the phone Completed sheet; shortcut help shows `↑ / ↓ / k / j`.

## Archive

Passes older than today have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so each pass records what that session believed at the time. The archive
holds:
- **2026-10-15 (moved 2026-10-16):** stable 95ddbc975 (#1507 boot exit), the host reboot, #1507-#1511.
- **2026-10-14 evening (moved 2026-10-15):** old worktrees closed, board fast again, trains
  48-49, #1489-#1494.
- **2026-10-14 morning (moved 2026-10-14 evening):** worker trains land, the lockfile
  incident, stable-20261014-5, #1478-#1486.
- **2026-10-14 night (moved 2026-10-14 morning):** two hand flushes, the reboot, #1444-#1477.
- **2026-10-13 (moved 2026-10-14):** compute moved to workers, `stable-20261013-3`, verify
  placement on, the WSL credential expiry, #1428-#1446.
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
