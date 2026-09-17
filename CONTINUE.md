# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-09-17 — #1191: conflict-aware train assembly (branch, not landed)

**On `feature/ak-1191-conflict-aware-assembly-overlap-graph-di`**, NOT on master and NOT pushed.
What it is: `assembleMergeTrain` no longer stacks members in plan order and drops whoever
happens to collide with an earlier sibling. For 2+ members it first builds a pairwise
member-vs-member conflict graph (`services/merge-train-conflict-graph.ts`: read-only
`git merge-tree` per pair, verdict cached per sorted tip pair in a bounded module cache, so a
bisect's sub-attempts over the same tips pay for no pair twice), keeps a maximum conflict-free
set (`pickConflictFreeSet`, greedy min-degree — a heuristic, exact MIS is NP-hard and a train
has ~4–13 members), stacks the kept set in least-overlap order (`orderByLeastOverlap`: fewest
remaining conflicts, ties by total degree, then caller order), and reports the connected
components as `conflictClusters`. A graph-excluded member is dropped as
`conflicts with <branch> (#N) — deferred to the next train` with `deferred: true`; it stays
ready, so the #905 window collects it on the next tick — that IS "train 2", no new orchestrator
queue. A base-only conflict is still dropped by the merge itself, not deferred. `--no-ff` and
`assertTrainPreservesAncestry` are untouched; nothing rebases a member branch.

Clusters reach ticket groups (decision 015) as **candidates**, never as auto-written edges: the
runner persists them in `merge_trains.gate_evidence.conflictClusters`
(`MergeTrainGateEvidenceDto`), and `propose_ticket_groups mode=train-conflicts` /
`POST /api/issues/group-scan {mode:"train-conflicts"}` (`scanMergeTrainConflictsForTicketGroups`)
reads the last 20 trains back, maps workspaces to live, non-terminal issues, excludes sequential
pairs, and proposes one group per component with the train labels in the rationale;
`apply=true` writes `coupled_with` through the existing `applyTicketGroupProposals`.

**Verified by:** `pnpm typecheck` green (5 packages); `pnpm check:arch` 0 errors (the 30
`startup-bypasses-repositories` warnings pre-exist); worktree vitest on the eight touched files
66/66 (`merge-train-conflict-graph` 16 incl. the cache block with an injected fake git;
`merge-train` real-repo: sibling conflict names the kept member + deferred, plan-order clash
`[clash, a, b]` now lands `a, b` and defers `clash`, base-only drop not deferred;
`merge-train-evidence` carries/omits clusters; new `ticket-group-scan-train-conflicts` 6/6:
propose, union across trains, terminal-member rejection, sequential exclusion, empty scan,
apply once); the four openapi tests 19/19 after `pnpm openapi:generate`; `bundled-skill-freshness`
after `pnpm skill:generate`. `pnpm test:mine -- --changed HEAD` ran at scope=full: shared
1240, mcp-server 197, client 1901 all green; server 9171 green with 4 failures, two of them this
change (both fixed — the skill regeneration, and `merge-train-orchestration` now pins the
least-overlap landing order `[f2, f1]` since f1 collided with the deferred f3) and two
load-flaky timing tests this diff does not touch (`base-branch-health-recency`,
`base-health-reprobe-guard`: 22/22 re-run alone, on a box that was swapping — a finding, not
this ticket's).

**Not done, deliberately:** `computePlan` (`merge-train-window.ts`) is not extended — the
pairwise cost lives in `assembleMergeTrain` so the sequential path never pays it. The prior
uncommitted draft auto-wrote `coupled_with` edges after every train; replaced by evidence + scan,
because decision 015 makes coupling an operator's call. No UI for the clusters yet (the
"Merge train" panel reads `gateEvidence` and could list them — backlog). A deferred member will
usually conflict with the BASE once its sibling lands and then take the per-ticket rebase path;
the deferral pays off when the sibling itself fails the gate.
## 2026-09-18 — #1194 + #1192 integration proof (throwaway branch `integration/ak-1194-plus-ak-1192`)

**Throwaway.** A merge of both feature branches to prove they compose, plus the one seam each
left for the other: `recordTrainReviewSiding` (#1194) now calls `recordTrainSidingDrop` (#1192)
for a member the review SIDED, so a blocking finding gets the same `workspace_train_siding` row,
`train-siding` tag, 409-safe nudge, cap and branch-tip re-admission as a conflict drop.
`runTrainReview` gained `repoPath` (arg) and `sendTurn`/`getBranchHeadSha` (deps); the runner
passes `repoPath` + its `sendTurn` through. The train tip recorded is the assembled `trainRef`
resolved to a sha at review time. Merge conflicts were `CONTINUE.md` and three keep-both hunks
in `merge-queue-train.ts` (import, `createMergeTrainRunner` deps, member fields).

**Verified by:** `pnpm typecheck` green; from `packages/server`, `pnpm exec vitest run
merge-train-review merge-train-siding merge-train-orchestration merge-queue-train --maxWorkers=2`
— 53/53, including the new `merge-train-review-siding.test.ts`: service layer (row/tag/nudge
land on the sided member only; held while the tip is unchanged; re-admitted with the count kept
once it moves; advisory and failed reviews write no row; no session port still records the row)
and a runner layer against real git with only the reviewer's reply canned, over three windows
(side → held before assembly, no review, no nudge → tip moves, re-admitted, lands, row and tag
cleared). `isSidingDrop` needs no change: it filters `result.dropped` (assembly conflicts) and a
review siding travels in `result.sided`, which never passes through it.

**Not on either feature branch, by design.** Known wording gap: the `/turn` prompt a review-sided
member receives is #1192's conflict text ("conflicts with work already on the train … run
`update-base`") with the review reason embedded; the ticket comment (#1194) has the right words.
An optional prompt override on `recordTrainSidingDrop` would fix it once both land.

## 2026-09-17 — #1194: train-scoped review, one reviewer per train (branch, not landed)

**On `feature/ak-1194-train-scoped-review-one-reviewer-per-tra`**, NOT on master and NOT pushed.
What it is: under `fast` (`reviewMode: "train-only"`), `sprint`, or an explicit
`review_mode_<project>=per-train`, the train runner no longer relies on N per-branch reviews.
After a GREEN pre-merge gate it runs ONE one-shot `code-review` (`invokeClaudePrompt`, cwd = the
gate's staging worktree, diff = assembled train vs base via `buildReviewContext`, every member's
criteria in the `{{members}}` block) — `merge-train-review.service.ts`. The reviewer answers with
a JSON `findings` list; each finding is attributed to a member (explicit `member` ref first, then
the unique owner of `file` among the members' `changedFiles`, else unattributed) and posted as a
`merge-attempt` system comment on THAT ticket. A CRITICAL/MAJOR finding under `fast` puts its
member in `sided`; `runTrainAttempt` then re-assembles the rest onto `<label>-sided` and lands
them WITHOUT re-gating (the combined tree already proved out). `sprint` runs the same review
advisory: comments only, nobody sided. Standard/strict/iterate skip it (per-ticket review runs).
Evidence: `gateEvidence.review` (`skipped`/`failed`/`ran`), `sided`/`sidedCount`, per-attempt
`sided`, verdict `sided` when every remaining member was withheld; the dispatch events report a
sided member as `skipped` ("sided by the train review: …"), not `failed`.

**Verified by:** `pnpm typecheck` green (5 packages). From `packages/server`,
`pnpm exec vitest run src/__tests__/merge-train-review.test.ts src/__tests__/merge-train.test.ts
src/__tests__/merge-train-evidence.test.ts --maxWorkers=2` — 32/32: decision per posture, parse +
attribution (explicit ref beats file owner, ambiguous file → null, MINOR not blocking, malformed
entry dropped, no JSON throws), `runTrainReview` against a real test DB with the agent injected
(comment lands on the sided ticket only; advisory sides nobody; a throwing reviewer → `failed`
and nobody sided); real-git `runMergeTrain`: w2 sided → w1 lands, w2 tip untouched and not on
main, ONE gate call, both train refs deleted; all sided → verdict `sided`, main unmoved; sided
inside a bisected sub-train. Dispatch/review neighbours (`merge-queue-train*`, `review*`, 12
files, 119 tests) still green.

**Deferred, deliberately — #1192.** Its `merge-train-siding.service.ts` (`recordTrainSidingDrop`,
tag `train-siding`, re-admission on branch-tip sha) lives on
`feature/ak-1192-sidings-a-conflict-dropped-member-gets-a` and is not in this tree. The seam is
`recordTrainReviewSiding` (TODO(#1192) in its doc comment): today it posts the findings comment;
once #1192 lands, add the `recordTrainSidingDrop` call there so a review-sided member is also
withheld from the next window until its tip moves. Until then a sided member is simply not landed
and re-enters the next window unchanged — it will be reviewed and sided again with the same
finding, which is loud rather than wrong. **Fail-open by decision:** a reviewer that cannot run
(CLI missing, timeout, no JSON) lands the train unreviewed and records `review.status = "failed"`;
the gate already proved the tree green, and a reviewer outage blocking every train is the failure
#1194 was raised to avoid. No `MergeGatePhase` for the review (the enum has no `review`; adding
one touches the client's phase rendering — separate change). Not yet done: the client "Merge
train" panel does not render `review`/`sided` (data is persisted, UI reads the old fields).
## 2026-09-17 — #1192: train sidings (branch `feature/ak-1192-…`, not landed)

Follow-ups found while finishing the branch, not ticketed yet:

- **Overlap with #1191 (`feature/ak-1191-…`, sibling branch, not merged).** #1191 adds
  `DroppedTrainMember.deferred` for a member-vs-member conflict that the next window
  re-collects untouched. #1192's runner sides every drop, which would hold a deferred member at
  a tip nobody asked to move. Guarded structurally (`isSidingDrop`, skips `deferred: true`), so
  the two branches compose without a merge. **After both land**: add a runner test that a
  deferred drop produces no siding row — it cannot be written on either branch alone.
- **No UI** for the `train-siding` tag beyond the tag itself; the held-out reason only reaches
  the queue as a `skipped` event. A departure-board column (#1186) could show "on siding N/3".
- **The cap comment lands under kind `merge-attempt`** — reuse, not a dedicated kind; fine
  until something filters by kind.
- Time injection: `TrainSidingDeps.now` was `() => Date` in the first commit and tripped
  `time-injection-spelling-ratchet` (5 > baseline 4); now `now?: string`.

## 2026-09-15 — #1160: verify-chain slots derived from capacity (branch, not landed)

**On `worktree-agent-a042194dae3f10a55`** (nested worktree `.claude/worktrees/agent-a042194dae3f10a55`),
NOT on master and NOT pushed — a human decides how it lands, then `pnpm promote` decides when it
goes live. What it is: `verify-chain-semaphore.ts` admitted ONE chain per process (hardcoded
since #903/#949); a real gate logged `queued 7410s behind another verification`. Now
`deriveVerifyChainSlots` (`shared/lib/machine-capacity.ts`, beside `deriveVerifyWorkers`) gives
`active + how many more chains fit` — another chain fits while 3 GB stays free over the 2 GB
Tier-0 reserve, under a CPU partition of at most 3 slots each worth 2 forks of the `cpus-2`
budget. The semaphore re-admits on every release and on a 30s tick while anything is queued.
`resolveVerifyMaxWorkers` divides the CPU share by `verifyChainMaxSlots()`, so N chains together
never exceed one chain's former core budget (RAM stays live, not double-counted). Gate message:
`workers 4 (derived, host free 9.4 GB, 2 of 3 verify chain slot(s) in use)`.
`KANBAN_VERIFY_CHAIN_CONCURRENCY` is still an unconditional pin (a `1` restores serialization).

**Verified by:** `pnpm typecheck` green (5 packages); `machine-capacity.test.ts` 44/44;
`verify-chain-semaphore.test.ts` 32/32 (new #1160 block: 3 concurrent on a roomy reading, clamp
to 1 on a tight one, door closes behind a chain that consumed the headroom, the 30s re-check,
release admits several, pin both ways, #978 order under width 2); new
`verify-chain-worker-budget.test.ts` (sum of shares <= one chain's budget, through the real
`resolveVerifyMaxWorkers`); `gate-builder-quiesce.test.ts` (message). Change-scoped
`pnpm test:mine -- --changed HEAD` and `pnpm check:arch` — see the commit message for their
result; this line is written before they finished.

**Not done, deliberately:** no live two-gate run on the operated board (that needs a promote);
the machine lock (`KANBAN_MACHINE_VERIFY_LOCK=1`) is a mutex and still serializes across
processes by design — widening it is a separate decision. `RAM_PER_VERIFY_CHAIN_GB = 3` and the
3-slot cap are estimates, not measurements: the first live pass with two chains in flight should
record peak RAM per chain (the `[gate:step]` lines plus `exit-record`'s `osFreeBytes`) and
adjust. Every pre-#1160 test asserting serialization still passes because
`resetVerifyChainSemaphoreForTests()` installs a SERIAL capacity reading by default — a test that
wants the dynamic path passes `{ capacity: ... }`.

**Also on this pass — the pnpm store lost two more shards.** `files/49`, `files/39` and
`files/d1` each held ONE entry that `ls` lists and `stat` refuses (the #1092/09-13 signature);
all three are parked as `files/<xx>.corrupt-20260915` next to `80.corrupt-20260913`. Fourth and
fifth occurrence in five days. `chkdsk C: /f` is now overdue by any standard.

## 2026-09-13 — board at ZERO open; `stable-20260913` live at `3d2d681710`

**The board is empty.** 1102 issues: 1092 Done, 10 Cancelled, **0 non-terminal**. The last to
land were #1108, #1110, #1111, #1113, #1116 and #1118. #1117 is Cancelled — it was filed on a
misdiagnosis of mine (below).

**`stable-20260913` is live on 3001** at `3d2d681710` (pid 31664), smoke passed (2 projects,
board status answered), rollback target `stable-20260912`. Master and `origin/master` are IN
SYNC — the 78-commit unpushed backlog the previous standing section described is gone.

**What blocked the promotion for hours.** `pnpm promote` refused repeatedly with `unverified`:
the base-health sweep returned no verdict in ~90s. The chain — `ak-1118`'s worktree had an EMPTY
`node_modules`, so its pre-merge gate died in ~4s (`ERROR: chalk.Instance is not a
constructor`); the monitor retried it; each retry queued a GATE-class waiter, which under #978
preempts the background base-health probe; the probe yielded mid-run and recorded `unverified`.
The empty `node_modules` was **NTFS corruption in the shared pnpm store**:
`~/.pnpm-store/v10/files/80/a0605c37…` lists but cannot be stat'ed, and `rm` refuses it with
"File exists" on a file `ls` can see.

**Second occurrence in two days** — the archived 2026-09-11 pass hit the same damage and
quarantined `files-<xx>-corrupt-2026-09-11`. Same workaround: `files/80` is parked as
`files/80.corrupt-20260913` (renaming the DIRECTORY works where deleting the child does not),
which makes pnpm re-fetch. **`chkdsk C: /f` is still the operator's, and is now overdue.**

**Then master went RED — honestly, which was progress.** With the probe unblocked the sweep
produced a verdict instead of a timeout: **1 failed of 8,907** —
`always-run-guard-runtime-ratchet`. Tonight's `072f643ffb` added the #1113 guard with a BARE
`@gate:always-run` marker, so it joined the unconditional floor at the assumed 3,000 ms and
pushed it to 569,748 ms against a 567,000 baseline. Fixed in `3d2d681710`: the guard declares
`when:packages/server/src/startup/**` (the one tree it walks), and `BASELINE_TOTAL_MS` moves
567,000 -> 570,000 with a **Seventh disclosed movement**.

**`when:` ALONE does not clear that ratchet** — it measures the WORST case (an unknown change
set forces every guard, preconditions ignored). The fifth and sixth movements say so about
themselves; I re-derived it the hard way after a "fix" that moved the number by zero.

**Tried and rejected:**
- **`--force-sweep`.** There WAS a verdict (red), so forcing would have promoted known-broken
  code and poisoned the next honest promotion. Never needed: #1044's logic recognised that the
  red verdict described a sha which was no longer the tip, and requested a fresh sweep itself.
- **Re-running `pnpm promote` after the harness killed its wrapper for low memory.**
  `promote.mjs` survives as an ORPHAN and keeps working (measured twice). A second concurrent
  run would tag, fast-forward and restart the operated board underneath the first. Read
  `promote.log`; do not relaunch.
- **Editing `auto_merge_disabled_<id>` to quiet the failing gate.** Prepared, then unnecessary
  once the store was repaired. No preference was changed this session.

**#1117 is Cancelled as a misdiagnosis**, with a correction comment on the ticket. "Merge POST
hangs forever" was my own `curl --max-time` being shorter than a ~759s gate; `http=000` was the
client, not the board. A real merge POST measured **369,583 ms**.

**The livelock worth never repeating:** 34 gate verdicts were DISCARDED under #243 (branch or
base moved during the run), including one 4,380s run that PASSED. The cause was my own rebases
and agent turns moving branches while their gates ran. Stopping all of it let #1108, #1110 and
#1111 land unaided.

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
