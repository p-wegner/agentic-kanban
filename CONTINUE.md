# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-09-22 — the last tickets: monitor landed six overnight, three needed a hand

**Landed overnight by the in-process monitor** (Start Mode `monitor`, WIP 2, merge owner
`merge_queue` → trains `2026-09-21-06`): #1142 #1200 #1143 #1216 #1217 #1218.

**Landed today with a hand:** #1219 (its first session died with 0 messages at the 2026-09-21
18:29 quota reset; checkpoint-committed its dirty worktree, `update-base`, `workspace resume` →
one commit → landed by the queue; one earlier gate was killed at exit 130 with zero FAIL lines —
a memory casualty, the queue retried it). #1220 (same dead-session shape; relaunched, then its
gate hit the god-module ceiling — `pre-merge-gate.service.ts` 1000 → 1016 — relaunched again to
split, landed via train `2026-09-21-07`). #1210 — see below.

**Fixed direct on master (#1221, Done):** `pre-merge-gate.service.test.ts` asked the REAL host for
free memory, so at < 2 GB free all 17 `runPreMergeGate` cases failed with "HELD — host saturated"
INSIDE `test:mine`, turning a branch gate red for a condition the real gate correctly reports as
held. Now mocks `resolveGateHostAdmission`; 33/33 at 1.8 GB free. Left open in the ticket: a guard
that catches the next unmocked Tier-0 read.

**Observed:** the monitor's `[monitor] Skipping auto-merge … auto_merge is disabled` line is
misleading when `merge_strategy = merge_queue` — merging is owned by the queue orchestrator, not
disabled. Trains on the stable build (pre-#1218) still write no per-leaf verify log, so a leaf
bisected out has no readable reason; a direct `POST …/merge` is how you get one.

**The stable board died at ~01:54 and nobody noticed for 6.7 h.** `[exit-record]` on restart: pid
35932 left NO exit record (killed without notice — OOM or a hard kill; it went down right after
#1210's direct gate had PASSED, before the merge step). Restarted 08:34 with the sanctioned
`node scripts/promote.mjs --restart-stable` (smoke passed, `stable-20260921-2`, pid 32640). The
first #1210 merge was therefore lost with the process; re-fired after the restart. Suspect worth
checking before the next long run: the board is spawned from inside a Claude session by
`promote.mjs`; if it dies with that session's process tree, it needs a service/scheduled-task home.

**#1221 grew a workspace of its own, and it landed:** the monitor started it in the minute
between filing and my Done move, and the builder implemented the ticket's "left open" half (a
ratchet against an unmocked Tier-0 read, `8260c97c26`) on top of the direct fix. Merged by the
queue as `f7025e1e0a`; #1221 is Done.

**Promoted: `stable-20260922-2` = `d1fe5d8178` is live on 3001** (smoke passed, pid 27968,
rollback tag `stable-20260922`). It carries #1210, #1220 and #1221; the authorizing sweep was
green on master tip at 2026-09-22T08:41:37Z, triggered by the promote run itself.

**Incident during that promotion, worth knowing before the next one.** `promote.mjs` does not
parse `--help` and treats an unknown flag as a LIVE RUN: it tagged, fast-forwarded and started
building. That build was then killed by a too-short wrapper timeout (exit 143), leaving
`dist/migrations/meta/_journal.json` gone and the board `degraded`; the script's own rollback was
cut short by the same timeout. Recovery was `pnpm build` + `db:migrate` + stopping the stale pid
by signature + `promote.mjs --restart-stable`. The operated DB was never touched.
Second-order effect: stopping that pid killed an in-flight base-branch sweep (stamp
`2026-09-22T07:09:14Z`), and the stamp is persisted so a restart cannot forget it — it blocks
every reprobe for the 65-min ceiling (5 clone + 15 install + 45 verify). A 40-min wait sat
entirely inside that window, so the first promotion attempt legitimately found no fresh verdict
and changed nothing. It self-healed at 08:14.

**The board is at zero open work.** 1204 issues: 1193 Done, 10 Cancelled, 0 open. WIP 0/2, no
workspaces, no sessions, and no `loop.sh` running. The next pass is a producer pass, not a
builder pass — nothing will auto-start because there is nothing to start.

### Next steps, in order
1. Refill the backlog — the board has no open ticket at all (see above). Until it does, every
   other step here is the operator's, not the monitor's.
2. `pnpm promote --dry-run` once master is quiet: #1216 (resolve-conflicts), #1218 (train reasons),
   #1219, #1221 are worth having on the operated board.
3. Re-enable auto-merge on the three fixture projects paused 2026-09-20 for CPU.
4. Box: kernel pool leak (`mssecflt.sys`) — a reboot is the only real relief; two builders plus a
   gate swap hard at ~2 GB usable.

### Verified by
Each landing is a merge commit on master (#1210 `270f2d2db0`, #1221 `f7025e1e0a`); `issue list`
shows nothing outside Done/Cancelled; the two gate suites ran 42/42 on master at 11.9 GB free
after the #1221 merge; the killed #1219 gate had 0 FAIL lines in its log.

## 2026-09-21 (evening) — the stranded set landed, backlog handed to the monitor

**Promotion is done**: `stable-20260921-2` = `f9f6ee0e2b` was already live on 3001 when this pass
started (`pnpm promote --dry-run` reported "already at" it); nothing was promoted again.

**Landed this pass** (each through the board's own gated merge, one at a time — the box had
1.2–2.3 GB usable RAM and was swapping, so no two gates ran together):
- #1146 (herdr safety-hook delegation; closed epic #1129 with it). Its first gate went red on two
  guards the tail-only message hid (#1218): a CRLF shebang in the reopened worktree's
  `.herdr/plugin/agentic-kanban-hooks.mjs` (index LF, tree CRLF — `rm` + `git checkout --` fixed the
  bytes) and the always-run runtime floor (new guard at the 3 s placeholder → 26 assumed files,
  ceiling 25). Fixed by measuring the suite alone (5,852 ms), banking it in
  `docs/tests/durations.json` and moving `BASELINE_TOTAL_MS` 576,000 → 582,000 with the fourth
  disclosed movement in the ratchet's own log.
- #1183 (coalesce stranded merge-train rows per project). Its worktree held the finished work
  UNCOMMITTED since 2026-09-17; committed, rebased onto master (two hunks: kept the #1164
  held-member skip before grouping, added `merge_train_changed` broadcasts on every abandon).
- #1120, #1150, #1152 — the three In-Review tickets with a CLOSED workspace and a live branch.
  Recovered with `workspace reopen` (#1206's path), rebased by hand / by two forks: #1120 was two
  small commits (nloc baseline re-measured to 456); #1150 shrank to ONE commit (the liveness
  registry and reconciler skip were already master's #1181, only the repo-lock wait-log evidence
  remained); #1152 shrank to ONE commit (the generator `.return()` half rested on a wrong premise
  about async-generator abort timing — the SSE route `onAbort` wiring is what master lacked).
  #1120 was picked up by auto-merge on its own; #1150/#1152 were NOT (no auto-merge log line for
  them in 30 min, reason unknown) and were fired by hand.
- Epic #1128 closed too (its remaining children #1142/#1143 stay as ordinary backlog tickets).

**Filed:** #1219 (auto-merge retries a worktree-less workspace of an UNREGISTERED project every
cycle — `ac389c58`, project `50c7e36a` is not in `/api/projects`), #1220 (the #936 discard message
names the same branch sha on both sides and hides that the BASE moved).

**Observed, not fixed:** `test-impact-map` holds the repo lock for ~40 s after every landing, so a
merge fired right after one is refused `repo_lock_held_cross_process` — retry, don't debug.
`/api/base-branch-health` and `/api/preferences/<key>` answer 404 on the stable build (the
project-scoped routes differ); `pnpm promote --dry-run` is the reliable read of the sweep verdict.

### Next steps, in order
1. Backlog (#1142 #1143 #1200 #1210 #1216 #1217 #1218 #1219 #1220) is being driven by the
   in-process monitor: Start Mode `monitor`, WIP 2, one start per cycle — set at the end of this
   pass. Watch RAM (`fleet status`); the kernel pool leak (`mssecflt.sys`, +260 MB/h) means a
   reboot is the only real relief.
2. #1216 first (it blocks #1209's resolve-conflicts on any real conflict), #1218 second.
3. Re-enable auto-merge on the three fixture projects paused 2026-09-20 for CPU
   (`c94e30c4…`, `c6355fcd…`, `bc221c46…`) once the box has headroom.
4. The `.claude/skills/test-impact` map is STALE in every worktree gate — rebuild on the main
   checkout (`impact.mjs build --durations docs/tests/durations.json`) when the box is quiet.

### Verified by
Each landing is a merge commit on master (`git log --oneline -6`); each ticket reads Done via
`issue get`; the #1146 fixes were re-run alone (`always-run-guard-runtime-ratchet` 3/3,
`shebang-eol-guard` 2/2) before the second gate, which passed. Fork claims for #1150/#1152 were
checked only by `merge-tree` clean + the branch's own tests (9 and 2 passing) — the gate did the
typecheck.

## Archive

Passes older than today have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so each pass records what that session believed at the time. The archive
holds:
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
