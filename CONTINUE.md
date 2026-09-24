# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.


## 2026-09-24 — review of the last landings, the #1228 gate loop, and the Yegge follow-ups

**Morning.** 3001 was down on session start; `node scripts/promote.mjs --restart-stable` brought
`stable-20260923` (`461837706c`) back on pid 3856. #1228 had failed its gate 31 times overnight on
one deterministic guard (`function-nloc-ratchet`, ledger rows `failed: []`, no backoff): the root
cause of #1230; its ticket comments hold the measurements (arch 43 s + typecheck 19 s + tests 118 s
per run).

**Filed #1230-#1236 (Backlog, tagged `no-auto-start` so the monitor waits for a human pick).**
The goal they serve: a merge pays only for what it touched, master may be red, the full suite
runs on master in the background and its misses feed back, promotion needs a green sweep or the
`--recover` lane. All seven landed the same evening (see below); each ticket's Done comment names
its commits and the group gate run.

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

### Evening — #1230-#1237 landed, wave B/C gated once, next wave is the rc model

**Landed on master, direct-master mode 3 (one subagent per ticket in a nested worktree, rebased and
fast-forwarded by the orchestrator).** Wave A: #1237 (`review.service.ts` names the LOCAL base;
`prevent-cross-worktree-writes.js` v6 hard-blocks base-ref writes under `KANBAN_WORKTREE_DIR`),
#1235 (`merge-train-worktrees.ts`, reaped by row state), #1236 (`cli-*.test.ts` on one bundled
CLI). Wave B/C: #1230 (`verify_failed` backoff 15 m → 4 h, a deterministic guard stops the
re-gate, ledger names the suites), #1231 (migration 0157 `scope`, sweep env allowlist, `promote`
refuses a non-`full` green), #1232 (`KANBAN_TEST_GUARDS=intersecting` under `iterate`, every bare
`@gate:always-run` now carries `when:` or `always`; measured client change 53 → 14 guards, 112 s →
51 s), #1233 (posture-aware `resolveBaseRedVeto`, `report` policy, `iterate` defaults to
`allow-file-debt-ticket`, one heal ticket per failure signature), #1234 (`durationMs` + step
seconds on ledger rows, `.test-impact/misses.jsonl`, `impactMissRate` on delivery/tracker/promote).
Decision 019 and `docs/integration-risk-ladder.md` are committed; #1238-#1242 filed (Backlog,
`no-auto-start`).

**Gates, once per wave.** Wave A at `dc1e0cc930`; wave B/C at `8c48dc9e0e`: `pnpm
gate:always-run -- --maxWorkers=2` (two reds fixed forward in `8c48dc9e0e`: ExecResult-helper
reads in the two new services, and the `cli-test` fixture family renamed by #1236),
`pnpm check:arch` (0 errors), `KANBAN_TYPECHECK_WORKERS=2 pnpm typecheck`. No per-ticket suite.
`pre-merge-gate.service.ts` hit 1001 lines under #1231 and is 965 after #1232's
`merge-gate-config.ts` extraction.

**Two things the board did on its own, both handled.** (1) It auto-started a workspace for
#1232 at 13:38 (`no-auto-start` was set after the monitor had claimed it); by the time the
subagent's branch landed, that builder was merging master into its own copy and had dropped the
merge-floor ratchet test. Stopped and deleted (two rows; the `.worktrees/.../ak-1232` husk
removed by hand). Nothing from it is on master. (2) Two `chore(monitor): sync objective.md`
commits (`76181f7e8f`, `68429075f6`) appeared on master mid-landing: a Bullseye save on the stable
board. Harmless; they moved master under a fast-forward once.

**Cleanup.** Eleven dead `.claude/worktrees/agent-*` husks from this and earlier sessions (no
`.git` link, no branch) removed with `scripts/safe-rmdir.mjs`; `git worktree remove` stops on
"Filename too long" for them. `.claude/worktrees/` is empty now.

**Wave D (later the same evening), same mode, gated once at `80ab329c40`.** #1240 (`flow`
level: impact tier, intersecting guards, `report` red-base policy, no master sweep, doc ratchet
`integration-risk-ladder-doc.test.ts`; the dev board is still on `iterate`, switching is the
operator's call), #1241 (`scripts/lib/repo-tree.mjs`; 14 guard suites migrated, private walkers
80 → 63 pinned by a ratchet, always-run floor 594 s → 561 s), #1242 (flake retry attributes by
disk, refuses a guard failure, ledger `retried: [...]`), #1238 (`rc/<date>` cut + sweep + promote
via `rc-state.json`, `?branch=` on the health routes, `promote_cadence_<id>` fired from the minute
tick as a detached headless run; landed as ONE squash commit because the branch carried a merge of
master — only a dry run was exercised, never a real rc promotion). Filed #1244 (hook-posture.js
mirror gap) and #1245 (base sweep's flake retry still header-only). Three agents stalled at their
first tool call (stream watchdog, 600 s); two resumed, one had a half-created worktree (no `.git`
link) and was relaunched fresh. #1239 (heal on the candidate + merge-back) is building now.

**#1239 landed too (`6962e3ac1f` + fix-forward `19aacf3583` for the route-body ratchet), gate
green at `19aacf3583`.** Every ticket of the rc model is on master; the builder's honest gaps are
in #1239's Done comment (no `healing` state written, no Settings field for
`heal_review_posture_<id>`, the merge-back workspace still launches a no-op agent).

**Master's own full sweep was red and is fixed.** The 19:45 UTC sweep on `80ab329c40` (39 min)
failed one suite, `workspace-actions-route.test.ts`; cause bc1c543a35 (#1230): the explicit merge
awaited a backoff clear against the default real db. Fixed in `879a5b1237` (route passes its
database; test mocks the seam). A fresh master reprobe was triggered at the end of this pass. No
heal ticket was filed because the stable board (`stable-20260923`) predates #1233.

**Bootstrap caveat for the first rc promotion.** `pnpm promote` now wants a sweep row for
`rc/<date>` (`--dry-run` at `19aacf3583` prints `WOULD REFUSE … wrong-branch`), but the sweep
with `?branch=` support runs INSIDE the board, and the stable board is still the old build. So the
first promotion onto today's master has to go through the old lane: a green MASTER sweep (in
flight) and then `pnpm promote --recover` (pipeline + rollback are the gate) or `--force-sweep`,
loudly. After that the rc lane is self-hosting. Operator's call.

**Also done:** auto-merge re-enabled on the three fixture projects (`auto_merge_disabled_*` =
false); `pnpm cli -- cleanup` removed the ten terminal train worktrees (2.7 GB). `cleanup` also
lists three registered projects with a missing repoPath (`tsz-coarse/medium/fine` under
`ticket-sizing-lab`); not touched.

**2026-09-25 00:xx — promoted.** Master's reprobe came back GREEN on `879a5b1237` (26 min). Master
had moved on (docs, the #1243 merge `7923d2886b`, whose gate needed five nloc shrinks banked on the
branch; #1250 filed for the missing merge feedback and is being built). The new promote lane wants
an rc verdict, so the first promotion went through the documented bootstrap:
`node scripts/promote.mjs --recover --with-migration --reason …` → `stable-20260925` on
`7923d2886b`, pid 28152, smoke passed, rollback target `stable-20260923`. A full sweep is OWED
(`<stable>/.kanban/promote-recovery.json`); the reprobe on the promoted board was triggered right
after. The stable board now runs #1233 (heal tickets), #1238 (`?branch=` sweeps, rc lane) and
#1239, so from here `pnpm promote` can cut and sweep `rc/<date>` itself.

### Next steps, in order
1. Land #1250 (in flight), then `pnpm promote --dry-run`: the rc lane should now cut `rc/<date>`
   and ask the promoted board for its sweep.
2. Decide the dev board's posture (`flow` needs `promote_cadence_<id>` set first).
3. #1246–#1249 (queue flush, observability first), #1244, #1245; the `tsz-*` missing-path projects.

### Verified by
Each ticket's Done comment (POST `/api/issues/:id/comments`) names its commits and the wave's gate
run; `git log --oneline dc1e0cc930..8c48dc9e0e` is the wave B/C landing; `git worktree list` has
no `agent-*` or `ak-1232` entry; `pnpm --silent cli -- issue get 1232` shows Done with no
workspace.

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
