# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-10-10 (later) — fleet worker e2e: six local rounds clean, Tailscale prep filed

**State.** Stable board runs `stable-20261010-2` (`0b7e7965d`, full green sweep of
`rc/20261010-2`, promoted 2026-10-10, smoke passed; rollback `stable-20261010`), carrying
#1315-#1323. `master` pushed after a clean confidential-terms scan of the range and of every
changed file in full. Board: #1324-#1329 open (Tailscale prep, Todo; #1329 is operator-run and
tagged `no-auto-start`).

- **Local fleet e2e, verified.** Dev board with `KANBAN_FLEET_PORT=3103 KANBAN_GIT_HTTP_PORT=3102`,
  a scratch node:test fixture registered as `wfx`, strict worker dispatch, a FRESH worker per
  round (own `--state-file`/`--work-root`, git transport, no `--shares-filesystem`). Each round:
  pair, doctors, build+review session on the worker, push, fast-forward, merge, tests green;
  daemon hard-kill, detach, restart. Round 6 found nothing new.
- **Frictions fixed by builders, each re-checked live with the next fresh worker:** #1315
  (full-CLI `worker` created a kanban.db), #1316 (`worker doctor` evicted the live socket; no
  `--work-root`), #1317 (detached session invisible; §9 stale), #1318 (`worker pair` prints the
  fleet URL), #1319 (`placements` shows `exit 1, worker lost`), #1320 (empty checkout shells),
  #1321 (dead session's registered checkout reaped at start and by `cleanup`), #1322
  (`kanban/<sessionId>` branches deleted), #1323 (`worker revoke`; `doctor-board` WARNs offline).
- **Tailscale prep (#1324-#1329):** durable fleet config for promote/stable:start (today the
  stable board only gets fleet env from the calling shell), bind retry, tailnet-scoped firewall
  script, board-served worker build, per-phase timings, and the operator-run tailnet lab checklist.

**Next:** build #1324 and #1325 before anything connects over the tailnet.

## 2026-10-10 — board drained: #1312, #1313, #1314 Done

**State.** Stable board runs `stable-20261010` (`cf5f7bda2`, full green sweep of `rc/20261010`,
promoted 2026-10-10, smoke passed), carrying #1312, #1313 and #1314. `master` pushed to origin 2026-10-10 after a clean
confidential-terms scan of the pushed range (26 terms, author identities included).
Board: no open agentic-kanban ticket.

- **#1312 merged** (lean Claude builder profile). Its first gate run had died with exit 130;
  the re-run was first refused by a dirty main checkout, then went green.
- **#1313 merged** (root CLAUDE.md slimmed for builders, operator material moved to
  `docs/agent-guide/operator-reference.md`, budget guard). Gate was red on
  `always-run-guard-runtime-ratchet`: the new guard counted at the assumed 3,000 ms. Fixed by
  banking its measured 3 ms in `docs/tests/durations.json`; neither limit moved.
- **#1314 (direct fix)** `workspace start --project <name>` sent the name as `projectId`; now
  resolved via `resolveProjectIdArg`. Check: a name resolves to the id, an unknown name errors.

**Next:** nothing open on this project's board; next work comes from `BACKLOG.md`.

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

## Archive

Passes older than today have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so each pass records what that session believed at the time. The archive
holds:
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
