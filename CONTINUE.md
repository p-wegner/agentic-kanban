# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-09-19 — board-tuning-lab folded into `sentinel` as an integrated lab

The standalone `board-tuning-lab` skill is gone. Its loop, the five dimension playbooks and
`snapshot.py` now live under `.claude/skills/sentinel/` (`references/lab.md`,
`references/lab/<dim>.md`, `scripts/snapshot.py`), mirrored into `.codex/skills/sentinel/`.
Sentinel's `SKILL.md` names the lab in one closing section, scoped to explicit lab requests;
a watch wakeup never opens it. The old `allowed-tools` pre-approval was deliberately not carried
over (a lab session now gets normal permission prompts), and the lab is not in sentinel's
description; the CLAUDE.md Skill Map row is its entry point.
- **New target, unrun:** a Sentinel target card (eval rounds over recorded wakeups, default form
  with no recorded run) in `references/lab.md` § Sentinel target card. Round 1 not started.
- **Open, found on the way:** `scripts/board-monitor/README.md` says the Sentinel prompts for
  the weekly planning pass; its `SKILL.md` has no such step. The card carries it as a trap.
- **Verified by:** the `.codex` mirror is byte-identical (`diff -r`), and the staged tree passes
  `codex-skills-parity` + `claude-md-skill-and-feedback-invariants` (2 files, 10 tests).

## 2026-09-18 — #1199: leaked E2ETest identity is NOT a 3-commit leak, it is the whole history

**Blocked on a human decision — no code change possible from this worktree.** The ticket asked to
reset `[user]` in the MAIN checkout's `.git/config` (`C:\projects\andrena\agentic-kanban`, not this
worktree) and decide on a history rewrite. Both are explicitly a human call per the ticket text and
per this repo's own conventions on shared, hard-to-reverse state — so nothing was edited here.

**What was verified, and it changes the scope the ticket described:**
- The main checkout's `.git/config` still has `user.name = E2ETest` / `user.email = e2e@test.local`
  (confirmed live, 2026-09-18).
- The ticket described three specific master commits plus a few worktree-branch first-commits as
  the affected set. The actual count is far larger: **3,178 of the commits reachable from `master`**
  carry `e2e@test.local` as author (`git log master --pretty='%H %ae' | grep e2e@test.local | wc -l`),
  and 3,238 across all refs. That is effectively the entire autonomous-commit history of this
  board's own development, not an isolated leak from #1192/#1193/#1194.
- 11 branches are currently open with commits under this identity, including every train-feature
  branch (#1190-#1198) and this ticket's own branch.
- Two OTHER stray identities also show up in `git log --all`: `E2ETest <peterwegner3141@gmail.com>`
  and `E2ETest <test@example.local>` — worth folding into the same decision rather than treating
  `e2e@test.local` as the only variant.

**Why this changes the recommendation:** rewriting authorship on 3,000+ commits already pushed to
`origin/master`'s ancestry is a different decision than amending a handful of unpushed tips. A full
rewrite needs `git filter-repo`, forces every existing clone/worktree to be discarded and re-cloned,
and needs a force-push decision on a shared remote. Given the scale, the practical options are
narrower than the ticket implied:
1. **Reset `.git/config` only, leave history as-is.** Cheapest, stops new leaks, treats the past
   3,178 commits as accepted historical noise (this repo's own convention: "move, don't delete" —
   history is not rewritten lightly, and here it demonstrably never was `Peter Wegner` to begin
   with for agent-driven commits).
   **This is not just a placeholder recommendation — it is the two-line fix that actually clears
   this ticket:**
   ```
   git config --file C:\projects\andrena\agentic-kanban\.git\config user.name "Peter Wegner"
   git config --file C:\projects\andrena\agentic-kanban\.git\config user.email peter.wegner@andrena.de
   ```
2. **Amend only the still-open branch tips** (#1190-#1198, this ticket) before they merge, via
   `git commit --amend --reset-author` on each branch tip — bounded, no shared-history rewrite,
   no force-push. Leaves the already-merged 3,178 as-is.
3. **Full rewrite** (`git filter-repo --commit-callback` remapping the three stray identities to the
   correct one) — technically possible but disproportionate at this scale; would need every open
   worktree/branch rebuilt afterward and a coordinated force-push.

**Recommendation, not yet actioned:** option 1 (reset config only) plus option 2 for branches still
open and easy to amend before merge. Full rewrite (option 3) is very likely not worth it given the
volume — flagged for the user's call, not decided here.

## 2026-09-18 — #1196 #1197 #1198 on master; the six train tickets are still In Progress

**On local `master`, not pushed.** Three follow-ups to the train merge, each its own worktree +
`feature/ak-<n>-…` branch, merged `--no-ff`:
- **#1196** — `base-branch-health-recency` / `-reprobe-guard` flaked when the host was saturated:
  `resolveBaseHealthProbeDue` reads the live host (`readTier0Capacity`, `readCpuBusyPct`,
  `resolveGateBusy`) and answered `host_saturated` on a swapping box (< 4 GB usable), so the
  "probe is due" tests failed for a reason outside the code under test. Both files now pin the
  capacity reads to a roomy host with `vi.mock`. A CPU-burn reproduction did NOT trip on the
  originals (22/22 green, the 150 ms sample missed the burn); the measured cause is the RAM floor.
- **#1197** — the merge-queue panel's summary bar shows the latest train's members with their
  outcome (`describeTrainMembers`: landed / deferred / dropped / sided / gate red / unresolved /
  aboard) and the member-vs-member conflict clusters of the last 10 trains, with a
  preview-then-apply "Propose coupled groups" (`POST /api/issues/group-scan`, mode
  `train-conflicts`). The `deferred` mark (#1191) now reaches the wire (`dropped[].deferred`).
  `GET /api/merge-queue/window` (AgentFlightRecorder) was unregistered with the
  api-response-validation ratchet — red on master since #1195, fixed here.
- **#1198** — the same bar draws the three shapes nothing rendered: the train review verdict
  (#1194, `describeTrainReview`: skipped / failed / N findings, M blocking), the bisect tree with
  #1193's `concurrentWith` and the concurrency saving (`describeTrainAttempts`, chips like
  `q1a landed ×3 ∥ q1b`), and #1192's siding state per member (`siding 2` / `siding capped (3)`
  on the chip, plus a "Held out on sidings" line for members the latest train did not carry).
  Siding state had no read surface: `GET /api/merge-queue/trains` now returns `{ ok, trains,
  sidings }` (`listTrainSidingStatesForProject`, workspace → issue → project), typed as the
  shared `MergeTrainsResponse` / `MergeTrainSidingDto`; the server's `TrainSidingRow` is an
  alias of that DTO so the wire-dto ratchet sees one declaration. Review-`sided` and
  rebase-`siding` are separate fields on `TrainMemberView`, since a member can carry both.

**Where the UI lives, and why:** #1187 (departure board) and #1189 (train detail drawer) are
In Review and NOT on master, so `MergeTrainSummaryBar` in `MergeQueuePanel.tsx` plus the pure
`lib/mergeTrainSummary.ts` are the only client surface for train history today. When #1189 lands,
its drawer should consume `describeTrainAttempts` / `describeTrainReview` rather than re-derive.

**Verified by:** all-package `pnpm typecheck` after each merge; client `vitest run
mergeTrainSummary MergeQueuePanel api-response-validation` (3 files / 26 tests at #1198); shared
`wire-dto` 6/6; server `merge-train-siding merge-train-review-siding merge-queue-window-route
openapi-drift openapi-thrown-status bundled-skill-freshness` 6 files / 39 tests after
`pnpm openapi:generate` + `pnpm skill:generate`; #1197's server run `merge-train-evidence
merge-train merge-queue-train openapi-*` 18 files / 174 tests. **Not verified visually** — no dev
server was started, so the bar has not been looked at with playwright-cli; that is the first
thing to do on a box with the server up.

**Still In Progress on the board, by the CLI's own guard:** #1190–#1195. `issue move … Done`
refuses while the issue has an open workspace, and each has one (its feature branch, merged by
hand into master but never through `workspace merge`). Neither reconciler will close them (the
hand-merged one skips issues with a live workspace, the ancestor one skips In Progress). A human
with the server up runs `pnpm cli -- workspace merge <ws-id>` (already-merged path) or `workspace
close` per workspace, then the move. #1199 (the leaked `E2ETest` commit identity in `.git/config`)
is deliberately untouched.

## 2026-09-18 — the six train branches are on master (#1190 #1191 #1192 #1193 #1194 #1195)

**On local `master`, not pushed** (this repo stays ahead of `origin/master` by design). Merge
order, chosen so every dependency was already present when its dependant landed: #1191 (clean)
→ `integration/ak-1194-plus-ak-1192` (brings #1192 + #1194 + the TODO wiring + the cross-branch
`merge-train-review-siding.test.ts`; conflict only in this file, keep-both) → #1193 (conflicts in
`merge-train.service.ts`, `merge-queue-train.ts`, `types/api/merge-train.ts`, this file) → #1195
(only the generated SKILL.md `commit:` stamp) → #1190 (`merge-queue-train.ts`, `merge-train.service.ts`).
The five per-branch passes that used to sit here moved verbatim into the archive.

What the conflict resolutions decided, because they are the places a later reader will doubt:
- **#1193 onto #1191/#1194**: `landGreenest` keeps the #1194 `sided` short-circuit and the #1191
  `dedupeConflictClusters` inside #1193's try/finally + `Promise.allSettled` split. The #1193
  base-moved re-assembly lives in the **no-sided** landing path only — the sided path already
  re-assembles the survivors onto the current base, so it needs no second recovery.
  `buildTrainGateEvidence` carries `concurrentGateSavedMs` AND `conflictClusters`.
- **#1190 onto all of that**: `trainId` sits beside the `TrainGate` type (whose ctx carries
  #1193's `label`); the self-describing commit (`label` + `evidence`) is wired into all three
  landing paths — plain, base-moved re-assembly, sided re-assembly — so no train lands with the
  default `Merge branch 'kanban/train/…'` message. The runner's old `q<base36>` label line went;
  `beginMergeTrain` mints `train/<date>-<NN>` and #1192's `partitionSidedMembers` runs before it.
- **Post-merge fix-ups on master** (own commit): `pnpm openapi:generate` and `pnpm skill:generate`
  re-run (the merge stitched routes from #1191 and #1195); two clock spellings the branches had
  each added alone (`now: Date` in `trainDateStamp`, `now?: () => Date` in `TrainReviewDeps`)
  tripped `time-injection-spelling-ratchet` once combined and are now `now?: string`.

**Verified by:** `pnpm typecheck` green (5 packages) after every merge; from `packages/server`,
`vitest run merge-train merge-queue ticket-group-scan-train-conflicts hand-merged-branch-reconciler
--maxWorkers=2` 23 files / 218 tests green at the final merge; the openapi gates (`openapi-drift`,
`-thrown-status`, `-route-coverage`, `-request-body-ratchet`), `bundled-skill-freshness` and
`time-injection-spelling-ratchet` green after the fix-ups. `pnpm test:mine -- --changed
efd36daedc --maxWorkers=2` over the whole merged range: 121 files, 1238 tests, ONE file red —
`drizzle-snapshot-baseline`, because #1192 shipped migration `0155_workspace_train_siding` without
its `meta/0155_snapshot.json`. Re-baselined per `packages/shared/CLAUDE.md` § "drizzle-kit
generate" (generated into an empty scratch out dir, `prevId` chained to 0154's id); that test and
`migration-schema-drift` are green again. Nothing else in the run was red.

**Left open, on purpose:** #1192's note "after both land: a runner test that a deferred (#1191)
drop produces no siding row" is still unwritten (`isSidingDrop` is structural, but nothing pins
it end to end). The `/turn` prompt a review-sided member gets is still #1192's conflict wording.
Both are small and belong to whoever next touches the siding service.

## Where this stands (2026-09-13)

**Read this section before the dated passes above.** Each dated pass describes the state at the
time it was written. Standing state lives here.

### Verified now (2026-09-13, ~04:25 local)

- **`master` = `3d2d681710`, working tree clean, IN SYNC with `origin/master`.**
- **Stable is `stable-20260913` = `3d2d681710`, live on 3001** (pid 31664); `/health` ok with
  all three checks green. Rollback target: `stable-20260912`.
- **Last full base sweep: GREEN at `3d2d681710`** (2026-09-13 02:23 UTC) — the sweep that
  authorized this promotion. It ran ~28 min.
- **Board: ZERO non-terminal tickets.** #1097, #1098, #1102, #1103, #1105, #1113 and #1118 are
  Done; #1117 Cancelled.
- **Auto-merge kill switch** `auto_merge_disabled_d1c5d9c1-…` = `"false"`, untouched all session.

### Next steps, in order

1. **Operator: `chkdsk C: /f`** (admin, reboot). Two pnpm-store corruptions in two days, plus
   `ak-1117-2` unreadable at the NTFS level. Quarantined, never repaired:
   `files-<xx>-corrupt-2026-09-11` and `files/80.corrupt-20260913` — both safe to delete after.
2. **`%TEMP%` holds ~82,000 entries**, reaper capped at 500/run. Far under the gate's 250,000
   floor (`DEFAULT_TEMP_ENTRY_CAP`), so it blocks nothing — but #1056 is what the far end looks
   like. `node scripts/sweep-temp-dirs.mjs` + `scripts/sweep-loose-test-db-files.mjs`.
3. **The Seventh movement should SHRINK at the next `pnpm test:durations` capture** — the #1113
   guard costs 4 ms of test time against its 3,000 ms placeholder.
4. **The Linux CI run is still unrun**; every sweep here is Windows-only.

### Unfiled findings from this session

Nothing was filed after the #1117 misfire, so these are recorded here rather than dropped:
- Three fix-and-merge sessions launched for ONE workspace within two seconds (00:34:48/:49/:50).
- A base sweep whose only failed suite is package-relative records NO test-impact outcome at all
  ("an incomplete failed set would understate the miss rate"), so a red sweep can leave the #954
  corpus with a hole. Seen live on the red sweep at `89aa325fd8`.
- `[test-impact] record args too long (~59,380 chars for 961 suites)` still silently drops
  outcomes. #1098 is Done for the ENAMETOOLONG spawn; verify whether it covers this path too.

### Which `[db] opening` line is normal

The stable board logs `[db] opening C:\Users\pwegner\.agentic-kanban\kanban.db (source: DB_URL)`;
that is expected. A **worktree** server logging the same file with `(source: home-fallback)` has
reached the operated DB — the #1095 hazard, not a normal path.

## Archive

Passes older than 2026-09-13 have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so each pass records what that session believed at the time. The archive
holds:
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
