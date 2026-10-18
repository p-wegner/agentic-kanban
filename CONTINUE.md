# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

**Operating the board (any state check, idle/stuck board, workers, profiles, posture, reboot,
promote): read `docs/agent-guide/operator-reference.md` first.** Full console:
`pnpm cli -- status --watch`. This line is standing; keep it when passes are archived.

## #1569/#1572 train shepherd: phases 1 and 2 landed (#691 residual below)

Done: one `TrainShepherd` per train, shared by incremental assembly and the red gate
(`merge-train-shepherd-wiring.ts`); `assembleMergeTrainWithShepherd` (`merge-train-incremental-assembly.ts`)
merges members into a real train worktree and hands a member-vs-member conflict to the shepherd
instead of deferring it (a conflict with the BASE is still dropped for its author); the red gate
reuses the same session via `shepherd.runner`; `createPlacedSessionRunner`
(`merge-train-session-runner.ts`) runs Claude with `--output-format json`, so a turn reports session
id, tokens and cost and the cost cap bites (conflict turns count toward it); an infra-held shepherd
makes the gate inconclusive (no builder feedback); a red nobody owns logs one `ATTENTION` line;
the shepherd line (session, worker, turns, last action) is in `gateEvidence.shepherd`, the train
drawer and `status --watch`. Verified by `merge-train-shepherd-phase2.test.ts` (real git repo).
**Not done:** (a) resume works only on the machine holding the session: a placed turn on another
worker falls back to a fresh session (disclosed in the prompt), so session reuse is host/same-worker;
(b) non-Claude providers report no usage, so the cost cap stays off for them; (c) the landing-time
re-assemblies in `merge-train.service.ts` (base moved, sided, rebased) still use ref-only assembly
and would drop a shepherd-resolved member instead of re-resolving it; (d) the assembly worktree has no
installed dependencies, so the shepherd resolves conflicts without running suites there.

## 2026-10-18 day: six trains landed, stable-20261018-3 live, master pushed

- **Stable = `stable-20261018-3` = 46ad62813** (promoted 21:30Z; fresh full rc sweep of
  rc/20261018-3 green, smoke passed; rollback target `stable-20261018-2` = ecb430e51). Promote ran
  in herdr pane w1:p62; console (`status --watch -i 60`) in w1:p5Z. Master and the tag are
  **pushed to GitHub** (scrubbed against the confidential-terms list and for local paths first).
- **Board is empty:** only #1618 (`status --watch` dies on one failed refresh) is open, In Review.
- **Trains today**, most landed by the operator in a sibling worktree (check:arch, typecheck,
  file-scoped suites + guards), subject "Merge train <label> (operator-landed)": 2026-10-18-02
  (ebf5db42e, #1569 #1583 #1589-#1591), 04 (b4f770200, #1572 #1597 #1598), manual 08 (772b0b2f0,
  #1599-#1601), board train 08 (48bdfb0d7, #1602-#1604 #1608), 09b (65930fa21, #1605-#1607
  #1609-#1616), 10 (46ad62813, #1617). Recipe: `docs/agent-guide/merge-trains.md`.
- **Why trains stalled:** the shepherd had 1 turn and a 20 min budget that also covered its
  re-gates, and never ran checks before handing back; the gate stops at arch, so tests never ran
  for it. Now `merge_train_agent_fix_max_turns`=3, `merge_train_agent_fix_timeout_ms`=5400000 on
  agentic-kanban, plus #1602. Operator actions that broke trains (commits/push during a gate,
  promote mid-fix, cancel losing the fix, 5 s console polling) are #1601 #1607-#1609 #1614.
- **Decisions:** `sprint` has no scheduled master sweep; only promote runs the full suite, gates
  use impact-reduced suites (decision 017, amendment 2026-10-18). The 1000-line ceiling is
  replaced by the **code-health posture** (#1613, decision 021): soft caps are recorded, hard caps
  block at pre-commit/implement-exit, a hard-cap breach is fixed to below the SOFT cap, and
  accumulated soft breaches file one cleanup ticket.
- The cleanup ticket is an ordinary ticket (Peter, 2026-10-19): default placement, the board pulls it in like any other.
- **ao-pf38 still needs its reboot** (shown `draining` in the console).

## 2026-10-18 night: trains 05, 07, 08 landed by hand, stable-20261018 live

- **Stable = `stable-20261018` = e1a6bbfa9** (promoted 00:08Z; fresh full rc sweep green in 2680 s,
  smoke passed; rollback target `stable-20261017-3`). Promote ran in herdr pane w1:p61; set
  `[Console]::OutputEncoding = [Text.Encoding]::UTF8` before piping it to `Out-File`, or the log
  holds `ÔÇö` for every em dash.
- **Operator-landed trains** (Peter: "you can fix the train and merge it"), each gated in a sibling
  worktree with check:arch, typecheck and file-scoped `test:mine` + guards:
  train 05 (47dd09cca, 10 tickets), train 07 (95bacc62b, 8: #1562 #1574 #1581 #1582 #1584-#1587),
  train 08 (e1a6bbfa9, #1579 only). Fixes were guard ratchets tripped by single members.
- **rc heal:** the first two promotes of rc/20261018 were refused (worker lost the job; then a
  90 s timeout because the rc-sweep and train 08's gate shared ao-pf38, #1589). The rc was
  fast-forwarded to master and re-swept with the train window held; heal ticket #1588 closed.
- `train land-local` (#1586) works but assembled a member the board had deferred (#1590, building).
- `.gitattributes` pins `*.snap` to LF (vitest rewrote both status-console snapshots every run).
- **Open:** #1569 (shepherd phase 1) conflicts with #1579 and needs a hand resolution in its next
  train; #1572; #1589; #1590. **ao-pf38 needs a reboot by Sunday midday** (FMfn leak ~8.6 GB).
- Master is 108 commits ahead of origin, **not pushed** (pushed later that day, see the pass above).

## Archive

Passes older than today have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so each pass records what that session believed at the time. The archive
holds:
- **2026-10-17 evening + morning (moved 2026-10-18 day):** train 04 by hand, stable-20261017-3,
  the reboot, hands-off under `sprint`, #1550-#1573.
- **2026-10-17 (moved 2026-10-18):** UX probe, stable-20261017-2, #1531-#1548.
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
