# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-10-16: backlog landed except #1528, promote blocked on a fit verifier

**Goal (Peter):** get the board backlog done using the workers.

- **Master = origin = 82250988e.** Landed 2026-10-15 evening to 2026-10-16 (trains 22, 10-16-01..08,
  two direct merges): #1478 #1495 #1501 #1503 #1510-#1527. Each push scanned CLEAN (only `From:`
  identity lines hit, accepted).
- **Stable still runs 95ddbc975**, so the live board lacks #1512's missing-deps fix: every red gate
  is re-run once after a reinstall (doubles a 30-50 min run), triggered by the log line
  `[services] reaper skipped — ... db unavailable`. Promote needs a green base sweep.
- **Base sweep:** red at 4c689511e (ao-pf38) ONLY on two mcp-server `beforeAll` timeouts (120 s):
  `disabled-tools.test.ts`, `tools/get-context-boundary.test.ts`; both pass in 8 s on the host. Cause:
  they spawn `node --import tsx` on the MCP server source. **#1528** (builder running) fixes that;
  then re-sweep and `pnpm promote` (dry-run first). Alternative waiting on Peter: `--recover` with
  the sweep owed.
- **Verifiers (verify_workers = ao-pf38 only):**
  - ao-pf38: kernel paged pool ~26 GB, tag **FMfn** (FltMgr file-name info leak, ~315-400 MB/h, even
    idle). Suspect `wtd` (Enhanced Phishing Protection). Reboot or disable is Peter's call; until then
    it is slow (mcp-server 25 min vs 105 s). Indexing turned off on its worker dirs (#1520 automates).
  - desktop-stable: **drained** and off verify. C: swings 0.7-6 GB with a 106 GB system-managed
    pagefile; hiberfil 25.6 GB. Peter's options: `powercfg /h off`, fixed pagefile, or pagefile on
    another drive. Then `drain=false` and add it back to verify.
  - wsl-stable: never for verify (shares host RAM; a sweep there dropped the host to 3.4 GB).
- **Host memory** is tight (3-6 GB free): Claude Code reaps background shells under pressure, which
  killed a full `test:mine` and two SSE `merge-queue` clients. Prefer auto-merge over held SSE calls.
- **Auto-merge is ON** again (was paused for the hand-queued trains).
- **Lint-like guards** (size ceiling, ratchets) reached builders only at the train; #1514 (landed)
  adds `check:static` at implement-exit, never held. Follow-up worth watching: send-back (rebase)
  sessions should run it too (comment on #1514).

**Next:**
1. Land #1528, re-sweep, promote; then re-add verifiers once Peter fixes ao-pf38 / desktop C:.
2. After the promote, confirm the missing-deps double runs stop (grep `missing-deps signature`).

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
