# Where the 77% rework actually happens

Measured 2026-08-23 for **#804** (candidate 3 of #762). #762 refuted candidate 1 — the gate is not
short of coverage; see [gate-test-selection.md](gate-test-selection.md). This page answers the three
questions #804 asks, with the data the board already holds.

Rebuild any number here:

```
node scripts/rework-loop-analysis.mjs --db <a COPY of kanban.db>          # human-readable
node scripts/rework-loop-analysis.mjs --db <copy> --json                  # machine-readable
node scripts/rework-loop-analysis.mjs --db <copy> --rev <sha>             # pin an anchor
```

The script is read-only against the DB (`node:sqlite`, `readOnly: true`) and reads git with exactly
two revision-pinned `git log` spawns. Measured at `4079a8476a`, 8602 commits, 2026-05-01..08-23.

## Short answer

**Q1 — often, and that is the finding.** 45.9% of fix commits are corrections to work that is still
on the same branch, before its merge gate ever ran.

**Q2 — after, essentially always.** The gate is the LAST check before landing: it runs a median of
1.4 min after the agent's session ends, and after the agent's last recorded test run in 71 of 72
cases. #804's framing — "the gate is running at the wrong TIME relative to the agent's own verify" —
is **refuted**. There is no earlier moment to move it to.

**Q3 — yes, but for a reason re-timing cannot fix.** 60.6% of the fixes that genuinely escaped a
gate ship a test with them, and 17.1% of them add a test file that did not exist at all. The
follow-up is stronger because it *writes a check that was not yet written*, not because it runs an
existing check the gate skipped.

**Therefore: do not instrument gate timing.** The measurement does not support it. What the numbers
do expose is a recording gap — see [What to instrument instead](#what-to-instrument-instead).

## Method, and how commits are attributed to a work unit

A "fix pair" is a `fix`/`revert` commit F plus the latest earlier commit P touching one of the same
files. n = 2415 pairs out of 2415 fix commits with at least one file — essentially every fix commit
has a predecessor, so the pairing is not a selective subsample.

Each commit gets a **branch group**: the merge commit that brought it onto master, or itself if it
landed directly on the first-parent chain. Two commits in one branch group came off the same
workspace branch.

**The proxy is validated, not assumed.** 88 merged workspaces still have both their
`base_commit_sha` and `merged_head_sha` resolvable in this checkout (the other 329 were
fast-forwarded or rebased and their original shas are gone), giving 539 commits with true workspace
attribution and 33 fix pairs where both halves are inside a recorded session window:

| Check | Result |
|---|---|
| branch-group proxy agrees with true same-workspace attribution | **32 / 33 = 97.0%** |
| of pairs in the same workspace, the fix is in the same *session* | 11 / 25 = 44.0% |
| commits of a known merged workspace that sit on the first-parent chain | 162 / 539 = 30% |

That last row is the proxy's known bias: a fast-forwarded branch is indistinguishable from a
direct-master commit by DAG shape, so the "never met a gate" bucket is an over-estimate. The
ticket→workspace method below bounds it from the other side.

## Q1 — does the fix land in the same work unit as the commit it fixes?

n = 2415 fix pairs.

| Relationship | n | share |
|---|---|---|
| **same branch group — fixed before its own merge gate ever ran** | 1109 | **45.9%** |
| the commit it fixes never met a gate (landed direct on master) | 733 | 30.4% |
| escaped a real merge gate, fixed later | 573 | 23.7% |

Gap from fixed commit to fix: median **0.62 h** overall, but the two populations are an order of
magnitude apart — **0.08 h (5 min) within a branch** versus **4.40 h across branches**. The
"median 0.5 days to the follow-up fix" that motivated #762 is an average over two different things.

Refining "same work unit" down to "same *agent session*": within one workspace, only 44% of fixes are
the same session; the rest are a later session on the same workspace (a relaunch, a turn, a
review-fix). Both are still pre-gate. So:

- **~46% of fix commits never reach a gate as a defect** — the branch is corrected first.
- Of those, roughly 44% are literally one session talking to itself, giving **~20% of all fix
  commits as strict same-session rework** (n = 25 for the 44% split — small, so treat the 20% as
  indicative and the 46% as solid).

This is the load-bearing result. Nearly half of what the rework metric counts is an agent iterating
on its own uncommitted-to-master branch. That is what iteration looks like, not what a gate escape
looks like, and no gate change can move it.

## Q2 — does the gate run before or after the agent's own last verify?

486 merged workspaces with sessions, from the board DB.

| Measure | Result |
|---|---|
| `merged_at` minus last session end | median **+1.4 min** (p25 +0.3, p75 +23.2) |
| merge (and therefore the gate) happened after the agent stopped | **446 / 486 = 91.8%** |
| `merged_at` minus the agent's last *recorded* test run | median **+4.5 min**, after it in **71 / 72 = 98.6%** |
| a session ran after the merge | 20 / 486 = 4.1% |
| workspaces needing more than one session | 392 / 486 = 80.7% |

The gate is strictly last. The 8.2% where it appears to precede the session end are the 4.1%
post-merge sessions plus rows where a session's `ended_at` was stamped late.

**Caveat that limits this answer, and is itself a finding:** only **105 of 1973 sessions (5.3%)**
recorded any test run at all, so the direct verify-versus-gate comparison rests on n = 72. The board
has no reliable record of whether an agent verified before it stopped.

## Q3 — is the agent's verify weaker than its follow-up?

What the fix commit carries, by whether it escaped a gate:

| Class | n | adds a brand-new test file | edits an existing test | no test at all |
|---|---|---|---|---|
| escaped a real merge gate | 573 | 98 (17.1%) | 249 (43.5%) | 226 (39.4%) |
| fixed pre-gate, on its own branch | 1109 | 5 (0.5%) | 192 (17.3%) | 912 (82.2%) |

Read it as: **60.6%** of gate escapes ship a check alongside the fix, versus 17.8% of pre-gate
fixes. So yes — the follow-up is a materially stronger check than whatever the agent ran.

But "stronger" resolves to "newly written". 17.1% add a test file that did not exist, and the 43.5%
that edit an existing suite are overwhelmingly adding a case to it, not re-running an old one. And
recall #762: for a `shared` change the gate already runs 428 server suites plus the whole client
suite. If an *existing* check would have caught these, the gate would have failed on them. It did
not. **A check that has not been written cannot be run earlier.**

The gate is also not passive: **70 of 486 merged workspaces (14.4%) had the merge withheld by a gate
failure at least once** before landing (8032 withholding comments across 104 workspaces — the
monitor re-attempts each cycle, so count workspaces, not comments; 2.8% of those workspaces failed
only ever with `BASE BRANCH ALREADY RED`). The gate bites.

## How much of this repo meets the gate at all

Two independent methods, because each has a known bias:

| Method | gated | ungated |
|---|---|---|
| by DAG shape (whole history) | 4673 | 2435 |
| by ticket → workspace (of the 1456 commits whose ticket resolves) | 266 (18.3%) | 1190 (81.7%) |
| by ticket → workspace, last 14 days (of 582 resolvable) | 29 (5.0%) | 553 (95.0%) |

DAG shape over-counts "gated" for old branch-heavy history and under-counts it wherever a branch was
fast-forwarded; the ticket method cannot classify the 5624 commits with no `(#N)` in the subject.
They disagree on the level and agree on the direction and the trend: **the share of work reaching
the pre-merge gate has collapsed as this repo moved to the direct-master mode.** Recently the large
majority of commits never meet it.

This reframes the whole rework question. The pre-merge gate is not the mechanism that most of this
repo's changes pass through, so tuning it — in coverage (#762) or in timing (#804) — cannot move the
repo-wide rework number regardless of how well it is tuned.

## What to instrument instead

Not gate timing. Three gaps the measurement hit, in the order they cost us:

1. **The gate never records that it passed.** `workspace_merge_gate` has **0 rows**, and a pass
   emits no comment — only a withheld merge does. Every gate number on this page had to be
   reconstructed by pattern-matching prose in `issue_comments`, which is why the pass rate is
   inferred (486 merged minus 70 withheld) rather than measured, and why the `tier:` line the
   CLAUDE.md tier-visibility rule requires appears in **zero** stored records. A row per gate run
   (workspace, ran_at, stage, tier, suites run, outcome, branch/base sha) would make "is the gate
   worth its cost" answerable, which today it is not. **This is a server behaviour change and needs
   its own decision — not made here.**
2. **Agent-side verify is invisible.** 5.3% of sessions record a test run. Whether the agent
   verified before it stopped is the pivot of Q3, and the board cannot answer it for 94.7% of
   sessions.
3. **The direct-master path has no gate record of any kind**, and is now where most commits land.
   #817 added an always-run enforcement point there; nothing observes it.

Do (1) and (2) and the same three questions become one SQL query instead of a 300-line script. Until
then, this page and `scripts/rework-loop-analysis.mjs` are the answer.

## What this leaves for #762's candidate 2

Untouched and still valid: the 100%-rework file list as an ordered characterization-test backlog,
with #762's caveat that `packages/shared/src/types/api.ts` (59/59) is `export type *` and cannot be
characterized by any suite that imports it — it needs type-level assertions, tests on its consumers,
or #780's runtime-checkable seam.
