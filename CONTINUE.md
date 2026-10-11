# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-10-11 — harness provisioning rounds (clean WSL worker + used desktop), paused for a reboot

**Goal (Peter):** a node-only machine becomes a worker from the Worker Fleet UI steps plus
`agentic-kanban-worker setup` (installs claude+codex, worker-owned clean config, login, pair,
doctor); the desktop runs only the partial setup (custom claude folder + auth). Repeat with a fresh
worker until a round finds nothing. Decisions taken: credentials are created on the worker and
never leave it; clean config by default; setup installs claude+codex.

- **Merged:** #1367 (clean harness dir, `auth`), #1368 (`setup`), #1369 (doctor prereqs, board git
  identity), #1373 (persisted harness mode), #1376 (half-open WS detection). Direct fixes on
  master: #1377 (`claude-code` intent id; restarted daemon stuck `draining`), #1375 stopgap (startup
  reconcile keeps worktrees younger than 30 min: the dev board deleted the stable board's fresh
  `ak-1373`), 439d4cde1 (master red from those two).
- **Open, branches committed:** #1372 (doctor default board, WSL worker name, no-provider warning,
  stale launcher) ready, gate queued; #1374 (Linux setup: PATH, /mnt entries, npm prefix, Linux
  self-update, start hint) gate interrupted (exit 130, memory); #1370 (UI connect steps + setup
  checklist) builder mid-session. Next: #1375 proper fix (ownership marker), #1371 (DESIGN:
  per-project stack), #1378 (run this repo's builders on a local WSL worker).
- **Rounds:** WSL round 0 (old product) -> #1372; round 1 (`akw-r1`, setup in a herdr pane,
  browser login) -> #1374, #1377; wfx #30 built, reviewed and merged on the WSL worker. Desktop D1
  -> #1373; D2 passed with three findings (added to #1372). Not yet: a round with no findings.
- **WSL images:** base `D:\wsl-images\akw-base-node22.tar` (Ubuntu 24.04, user `worker`, node 22;
  its /usr/local/lib/node_modules is user-owned, unlike an apt node). Import per round:
  `wsl --import akw-rN D:\wsl-images\akw-rN D:\wsl-images\akw-base-node22.tar`.
- **Laptop memory:** the Defender for Endpoint filter (MsSecFlt) leaks kernel pool per file opened
  on C: (~8 GB after 3 days); see `Documents\performance\2026-10-11-kernel-pool-leak-for-IT.md`.
  At < 4 GB free, gates get interrupted and background tasks reaped.

- **Second reboot (16:xx local): git object writes on D: hung in the kernel** from 15:02 local
  until the reboot. `git hash-object -w` in a fresh repo on D: stopped after writing `tmp_obj_*`
  (one thread, wait reason Executive, unkillable); the same on C: was instant; plain writes,
  renames and hardlinks on D: worked. Only WdFilter (Defender AV) is attached to the Dev Drive
  (`fltmc instances -v D:`). Symptom chain: worker pushes to :3002 hung 600 s (board's
  receive-pack/unpack-objects waited forever), then GCM popped a login prompt on the desktop
  (#1383), gates and builders hung. Check first next time: a timed `git hash-object -w` on D:.
- #1375 and #1379: the desktop's follow-up commits never landed (pushes hung); fetched as git
  bundles over ACP instead of re-pushing, because their assignments are over.

- **WSL round 2 (`akw-r2`, build 17f5800fd, Connect-tab Linux steps pasted literally):** download,
  sha256, install, setup (claude 2.1.296 + codex installed, PATH saved for the daemon), pair, doctor
  0 FAIL work. wfx #31 built (agent 34 s) and reviewed (7 s, "no critical or major issues") on the
  WSL worker, merged. The login was done by copying the main profile's `.credentials.json` into
  `~/.agentic-kanban/harness/claude` (Peter's call; not read). Frictions: #1386 (high: setup leaves
  harness mode `inherit`/legacy, so start uses an empty `~/.claude`; worked around with
  `start --clean`), #1387 (Connect tab steps 1/2/4-7, numbering, "Expires just now"), #1388 (token
  expires during login), #1389 (node:sqlite warning), #1390 (WSL worker named like the host). To
  pin wfx to that worker: `--labels wsl` + `worker_labels_<wfx>=wsl`, strict.
- Also filed: #1384 (pre-merge leftover commit stages `*.tmp.<pid>.<hex>`), #1385 (high: worker
  startup cleanup deletes checkouts whose result is undelivered; seen on desktop-stable).
- Merged: #1370 (cap 55 -> 56 by hand), #1375 (desktop's commits via git bundle). #1379 rebased by
  hand (attestation types moved to `worker-profile-attestation.ts`; cap 57), daemon split by a
  builder, gate running.

- **Rounds 3-5 (evening):** round 3 (`akw-r3`) verified #1386/#1387/#1388 live, found #1394.
  Round 4 (`akw-r4`, master a0c77d70c) crashed at `agentic-kanban-worker setup`: #1389 added
  `import { createRequire }` to db-path.ts and the bundle banner imports the same name
  (`Identifier 'createRequire' has already been declared`). Fixed direct (b85e3c277: banner
  aliased in build-worker/-server/-mcp; both bundles load). Round 5 (`akw-r5`): no sqlite warning
  (#1389), distinct name `AO-PF69VL7N-wsl-akw-r5` (#1390), online at once (#1394) but labels
  ~30 s late (#1396). Also filed: #1391 (shared /tmp), #1392 (remote output not live), #1393
  (status --watch layout, merged), #1395 (high: verify exit 130 reported as failure).
- **Promote NOT done:** `rc/20261011` is in flight at a0c77d70c (the broken bundle) and promote
  reuses an in-flight rc. Stopped the promote at the sweep wait. Before promoting: get the rc to
  include b85e3c277 (or abandon it) - read `scripts/rc-state.mjs` / docs/two-boards.md "rc
  lifecycle". The stable board still runs stable-20261010-6.

**Next:** finish round 5 (wfx #33); land #1396; promote once the rc carries b85e3c277; desktop D3.

## 2026-10-10 (night) — tailnet rounds 3-4: newcomer install works, no frictions left

**State.** `stable-20261010-6` (11dc8da40) is live (promoted after a green sweep of `rc/20261010-6`,
adds #1356-#1362). Board: only **#1337 (DECISION for Peter: plain LAN with Tailscale
fallback)** is open on this project. #1329 (tailnet lab) closed with the evidence list.

- **Round 3 (fresh worker `desktop-r3`)** found: fleet doc unreachable from a worker machine and
  `/build` needing a worker token (#1358), doctor false WARNs (#1359), `update-check` judging the
  global launcher by semver (#1360, plus the direct fix #1362), the firewall check timing out on
  372 rules and then false-warning unelevated (#1357, #1361), and 15-95 s workspace creates from
  skill materialization copying a `.venv` (#1356). All merged; each verified live except #1356
  (measure `resolve-prompt-skill` on the next creates after this promote).
- **Round 4 (`desktop-r4`)**: installed from ONLY the steps `worker pair` prints, paired on the
  current build; wfx #28 build+review clean in 54 s. No frictions reported on the run. The
  desktop's report on the install steps themselves was lost on the ACP bus (ids 68/70); asked
  for a resend.
- **Worktree race:** no recurrence since `stable-20261010-5` (creates during merge trains clean).
  If it recurs, grep `[worktree-admin]` around the failing create.

- **After the promote (`stable-20261010-6` live):** #1356 measured on a probe create:
  `resolve-prompt-skill` 4.5 s (was 12-81 s), create 8.7 s; the rest is plugin skill listings
  (29 skills, 4.4 s), noted on #1356. #1364 (direct): the printed bootstrap failed in Windows
  PowerShell 5.1 (`curl` = Invoke-WebRequest); steps now name `curl.exe`, checked live (exit 0).
  Master scrubbed (26 terms, CLEAN) and pushed.

- **Rounds 5-7 (fresh worker each, Windows PowerShell 5.1, printed steps pasted literally):**
  round 5 found the commands still saying `curl`, `…` mojibake and a firewall-script pointer
  (#1365, direct); round 6 found the build window breaking the steps (202 + `curl -f` exit 0, then a
  stale global binary pairing) and em dash mojibake (#1366: `?wait=120`, pairing build-mismatch
  warning, ASCII-only worker console with a guard). **Round 7 clean:** no prior worker, step 1
  waited 58 s through the packing window, desktop-r7 paired on f3d72ef1b, doctor 0 WARN/0 FAIL,
  0 non-ASCII output; wfx #29 build+review clean. Loop closed.

**Next:** promote master (#1364-#1366 not yet on stable). Peter:
decide #1337, and add the stable fleet firewall rules (`scripts/fleet-firewall.ps1 -Install`,
elevated) before a worker targets the stable board.

## Archive

Passes older than today have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so each pass records what that session believed at the time. The archive
holds:
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
