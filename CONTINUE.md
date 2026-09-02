# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-09-02 — #995: merge-status can report an INTERRUPTED merge, so waiting no longer loses information

**#995 is Done.** `GET /api/workspaces/:id/merge-status` now answers `outcome: "interrupted"`
for a merge that died before reaching a verdict, instead of the never-tried sentence.

### The mechanism, which is the part worth keeping

The interruption was always recorded — `merge-run-reconciler` writes a `merge-attempt` note that
correctly distinguishes "interrupted" from "gate failed". What broke the endpoint is that the
same step is **destructive**: it writes the note and then calls `clearMergeRun`, deleting the
#945 in-flight marker that `describeAbsentMergeJob` reads. So immediately after a crash the
endpoint answered correctly, and after the sweep it degraded to *"no merge job recorded for this
workspace in the current server process"* — verbatim what a workspace nobody ever tried to merge
gets. **The longer a client waited, the less the endpoint knew**, which is backwards for a
poller, whose entire behaviour is to wait. Measured on `merge-42eb8b43-1` (#988), reported by the
test-impact session whose poller sat across the sweep.

### What landed

- `getLatestInterruptedMergeRecord` (`repositories/issue-comments.repository.ts`) reads the
  durable note back. **Only the NEWEST `merge-attempt` note for the workspace counts** — not "an
  interruption somewhere in this workspace's history", which would report a stale interruption
  for a workspace that was since re-submitted and failed its gate.
- `describeAbsentMergeJob` gains an `interrupted` branch ranked directly below `merged` and
  ABOVE the gate verdict, sourced from the live marker OR the record. The gate verdict is not
  dropped on that path — a retry still wants to know it can reuse a passing gate — it is demoted
  from the answer to a detail of it. Full ranking now: **merged > interrupted > reusable gate
  verdict > nobody ever tried.**
- The `mergeReason` stamp is one exported constant (`MERGE_INTERRUPTED_BY_RESTART`) that the
  writer and the reader now share, instead of two matching string literals.
- Option 2 from the ticket (make the marker non-destructive) was NOT taken, as the ticket
  preferred: it grows a row that then needs pruning.
- The un-ready behaviour is untouched, as the ticket's "Do not" section required. Not
  auto-resubmitting after an interruption is correct; the gap was purely reporting.

### Verified by

- `merge-status-absent-job-interrupted.test.ts`, 5 cases including three that are about NOT
  over-claiming: a newer gate-failure note supersedes an older interruption, a landed merge
  outranks a recorded one, and an unknown workspace id never reports interrupted (the read is
  `.catch(() => null)`, and a truthiness slip there would invent an attempt that never happened).
- **Negative control**: stubbing the new read to `Promise.resolve(null)` — i.e. the pre-fix
  behaviour — fails exactly the one case that is about the post-sweep world, and no other.
- Impact selection for the change: 20 suites, 133 tests, all green. Guards-only set green (298s).
  Typecheck green.

## 2026-09-02 — #994: two always-run guards no longer time out, and the reason was I/O, not git

**#994 is Done.** `max-file-size.test.ts` ("no source file exceeds the 1000-line hard ceiling")
and `shebang-eol-guard.test.ts` ("every tracked shebang file has eol=lf") were timing out at
vitest's 120 s limit under load, and a timeout is reported as a test FAILURE — i.e. as
"a god-module breached" and "a shebang file is unpinned", both real, both merge-blocking, so an
operator could not tell a contention artifact from master actually being broken.

### What the cause turned out to be, and where the ticket's guess was wrong

The ticket blamed `git check-attr`. Measured, `check-attr` over all 80 shebang paths costs
**57 ms** — it was never the problem. The cost is **plain file I/O on a cold page cache**:

- `shebang-eol-guard` ran `git ls-files` and then `readFileSync` on **all 3704 tracked files**,
  **twice** (once per assertion, no memoisation). Measured: **61.5 s on the first run of the
  session, 1.44 s on the immediately following one.** Essentially the whole cost was per-file
  opens; on a loaded box the ticket measured 202 s.
- `max-file-size` re-walked and re-read the ~1448-file source tree once per `it`, three times.
  4.3 s warm, 158 s in the ticket's loaded run.

### The fix

- **`shebang-eol-guard` gets its candidate list from `git grep -l -a -z -e '^#!'`** — one process,
  ~0.5 s — and still checks the first two bytes itself, so `^#!` matching mid-file only
  over-selects (83 candidates against the 80 real files) and never under-selects. Verified the two
  approaches return the **identical 80-file set** before switching. The list is memoised, so the
  second assertion re-uses it. File opens: **7408 → 83.**
- **`max-file-size` walks once** and reads through a new memoised `readGuardSource` in
  `helpers/guard-scan.ts` (beside the existing memoised `parseGuardSource`).
- Both suites carry an explicit `SCAN_TIMEOUT_MS = 300_000` on their scanning `it`s. A
  tree-scanning guard really is long-running; the honest outcome under contention is a slow PASS,
  not a fast lie.

### Verified by

- **Negative controls, both suites** — the point being that a faster guard that no longer guards
  is worse than a slow one. Converting `scripts/check-god-modules.mjs` to CRLF fails the byte-half
  of the shebang guard by name; appending 1200 lines to `issue-priority.ts` fails the 1000-line
  ceiling at 1239 lines. Both reverted, tree clean.
- **The whole always-run set**: `KANBAN_TEST_GUARDS_ONLY=1 KANBAN_TEST_MAX_WORKERS=2` — all guard
  suites passed, 277 s, no timeouts.
- `node scripts/typecheck.mjs` green (36 s, 1 worker).

### One thing this made WORSE, recorded rather than dropped

`always-run-raw-read-ratchet.test.ts` (#888) caught the change and its baseline for
`shared/max-file-size.test.ts` dropped 2 → 1 — because that ratchet detects
`readFileSync(<repo path>, "utf8")` at the call site, and the line-counting read now sits behind
`readGuardSource`. That is the **helper-hidden-read blind spot the ratchet's own header names**,
and it is now one file wider. The read itself is still CRLF-safe (`text.split("
").length` counts
`
` either way), so nothing is broken today; what changed is that the net stopped watching it.
The baseline entry says so in full. Teaching the ratchet to follow `readGuardSource` is the real
fix and is deliberately NOT done here — it means changing a second always-run guard's detection on
a ticket about two slow ones.

### Cold-cache caveat — what is measured and what is inferred

Measured: the read counts, the warm timings, `check-attr` at 57 ms, and the 61.5 s → 1.44 s
cold→warm collapse that identifies per-file I/O as the whole cost. **Inferred, not measured:** the
cold/loaded run is now fast enough, since dropping a Windows page cache on demand is not something
this session can do. The inference is direct (45× fewer file opens against a cost shown to be
almost entirely per-file opens), but it is an inference. If a loaded gate ever times out in one of
these two again, the timeout ceiling above is what keeps it honest in the meantime.

## 2026-09-01 — verification cadence: the fast gate is real, and its map had rotted

**Standing state for the test-impact / fast-gate work.** Read this before the dated passes below.

### What is true and verified now

The three-part goal (narrow per-merge gate, narrow builder inner loop, full suite nightly) is
CONFIGURED AND WORKING on this board. Verified end to end today, each by direct observation
rather than by reading the design doc:

- **Merging uses the impact selection.** `risk_posture_<board>` = `iterate` → `gateTier: impact`,
  `sweepIntervalMs` 24h. Confirmed the empty `verify_gate_strategy_<board>` pref does NOT win
  (`""` is not in `VERIFY_GATE_STRATEGY_VALUES`, so the resolver falls through to the posture) —
  worth knowing, because an explicit tier DOES outrank the posture and would have made the flip a
  silent no-op.
- **Ticket implementation uses it too.** `test_impact_budget_<board>` = `120s`, and
  `resolveTestImpactBudgetEnv` emits `KANBAN_TEST_SELECTOR=impact` alongside `KANBAN_TEST_BUDGET`,
  which `withBuilderTestImpactBudget` puts into every BUILDER's launch env.
- **Measured selectivity**, on a real 12-file diff: `tier: impact, 226 test file(s) selected` of
  1290 known, inside the 120s budget, 76 dropped below the score floor.
- **The nightly sweep runs.** `base_branch_health` shows this board's sweeps, most recently a
  green at 2026-09-01T10:47Z (33 min). The ledger wire (`recordBaseSweepOutcome`) is reachable
  and correct.

### The thing that was actually broken, and will break again

`docs/tests/impact-map.json` was stamped `2e04e24667` — **46 commits stale** — so every selection
was silently escalating `tier: impact` → `tier: package`. Both consumers degraded together: the
merge gate AND every builder's inner loop. Rebuilt at `0ad14fe6b7` with `--durations` (the 1169
measured durations are erased by a rebuild without it, #955).

**FIXED the same day at `771ab84644`** (#993, expensive half). The refresh was a PHASE INSIDE
`runMonitorCycle`, and this board's `start_mode` is `manual` — a true kill-switch — so the cycle
never ran here and the map could not refresh itself; `test_impact_map_refresh=true` made no
difference. It is now `test-impact-map-reconciler`, a background sweep in `BACKGROUND_SERVICES`,
which runs at boot regardless of start mode (15-min interval; a full pass with nothing to do
measures 1111 ms, because the freshness check short-circuits before the repo lock). The monitor
phase is deliberately kept for its fork-freshness coupling — the pass is idempotent.

Verified in production, not just in tests: registering it hot-reloaded the dev server, and at
20:21:37 the sweep detected the staleness #989's merge had just created and committed
`f2c47e9c54 chore: rebuild test-impact map @ 3173abcf8b` unattended. Selector reads
`behind=1 stale=false tier=impact`.

**#993 is CLOSED.** Its other half — making the rot visible — turned out to already exist, and
saying so is the point of this paragraph rather than quietly dropping it.

`GateImpactSelection.stale` has been in the gate message since **#956**: populated by
`resolveGateImpactSelection` from the skill's own selection description, rendered by
`buildImpactSelectionNote` as `, map STALE` / `, map fresh`, and covered by
`gate-tier-impact.test.ts`. A gate whose selection ran on a stale map already names it beside the
tier. Two of us (this session and test-impact-skill) believed it was missing; a
`[test-impact:inventory]` consumer was written and typechecked before anyone checked, and would
have printed the staleness twice. Reverted unshipped.

Residual, recorded so nobody re-derives it as a hole: the clause says `map STALE` but not HOW
stale. `behind=<n|unknown>` from the skill's record could join the EXISTING clause if that ever
matters — a nicety, and a small window now that the map self-heals within 15 minutes.

### Unverified / outstanding

- **The miss rate is still not measured, which is the whole safety argument.** The ledger holds 25
  rows, ALL from gate runs (`ci` / `ci-partialselection`) and **zero from base sweeps**. Current
  reading: `miss rate 0% — 0 of 3 failing full-scope runs`, i.e. three witnessing runs against
  #954's ~50-run target. Not broken: the sweep→ledger wire landed at 13:14 today (`2ebe615fb3`)
  and the board's last sweep was 10:47, so no row was possible yet.
- **Corpus accrual is now ~1 base-sweep row/day**, because the posture moved the sweep from
  roughly hourly to 24h. That is the right cadence for a backstop and a slow one for building the
  corpus that justifies the weaker gate — worth revisiting deliberately rather than discovering in
  two months.
- Step 5 of `docs/proposals/2026-09-01-verification-cadence.md` ("report the measured miss rate
  and revisit") is the open item. If the rate is bad, `iterate` is the wrong setting for this board
  and the flip gets reverted with data.

### Also landed today, and why it matters here

Master was red on **six** guard suites, which blocks every merge on the board and therefore this
work: four from #987 (`b10406295e`), the stale `typecheck` wiring assertions from #980 (`7fbef4371d`,
`79546d131a` — the third was in `packages/shared` and no ticket had named it), and #976 appending a
section AFTER the board-feedback heading, which `retargetBoardFeedback` truncates (`51a294fd90`).

Two traps worth not re-learning:
- **#991's diagnosis was wrong** on its load-bearing claim: #980 never dropped the shared-dist
  freshness call (it is at `typecheck.mjs:98`, verified by `git show` and by watching a rebuild
  fire). Only the ASSERTION was stale. Following the ticket literally would have added a second
  call and rebuilt shared twice per typecheck.
- **Decomposing a route silently shrinks the OpenAPI spec.** The generator collects statuses only
  from the handler body it scans. Lifting handler bodies out lost a 422; moving the registration
  out (shape C) lost both 200s. Only registration-in-helper with every `c.json` INLINE keeps them,
  and the helper's first param must be typed literally `Hono`. Regenerate and DIFF the statuses —
  the drift gate is happy with a smaller spec.

Known flake, filed as **#994**: `max-file-size` and `shebang-eol-guard` TIME OUT at 120s under
4-worker load (they pass in isolation) and a timeout renders as a normal test failure — so a red
`max-file-size` reads as "a real god-module breach", which is indistinguishable from the real thing.

## Where this stands (2026-08-27)

**Read this section before anything below it.** Everything under it is a dated pass and
describes the state *at the time it was written*. A continuation scraper previously pulled a
"Next steps" list out of the 2026-08-23/24 pass and handed it to a fresh session as current —
three of its five items were already closed. Standing state lives here and nowhere else.

### Verified now (2026-08-27)

- **Branch `master`, working tree clean, 36 commits ahead of `origin/master`, 0 behind** —
  a clean fast-forward (`git merge-base --is-ancestor origin/master master` passes).
  `origin` = GitHub `p-wegner/agentic-kanban`; there is a second remote `gitlab`
  (`code.andrena.de/pizza-und-ai-code/agentic-code-review.git`) — do not confuse them.
- **#807, #831 and #834 are all Done** (checked via `pnpm cli -- issue get <N>`, closed
  2026-08-26). Any older text below that treats them as open or as blockers is stale.
- **Board: 17 open** — In Progress #905, #906, #907 (merge train); In Review #922;
  Todo #923, #924; Backlog #909–#919.

### Next steps, in order

1. **Operator: decide the push.** 36 commits, clean FF. Its *old* rationale is gone — #834 and
   #807 both closed without it. What it buys now is a Linux CI run, which is what **#923**
   (board-events + conductor-lifecycle failing on the runner) needs to move.
2. **`pnpm --filter agentic-kanban test` on an idle box** — still the outstanding whole-repo
   gate. See "Deferred on machine load" below; this has been deferred across several sessions
   and is genuinely unverified, not merely unrecorded.
3. **#922** (In Review) — disclose-context PostToolUse hook into the worktree scaffold.
4. **#924** — investigated 2026-08-28: already fully solved by #893 (`4ce27bb3dd`,
   `workspace_merge_gate` persisted verdict + `describePersistedGateVerdict` on
   `GET /merge-status`), inherited on this branch from master. No code change made;
   closing as a duplicate rather than re-implementing. See the dated section below.
5. **#905–#907** (In Progress) — the merge-train batching/persistence/one-review-per-train trio.

### Deferred on machine load, with the reason

`fleet gate --count 4` returns **BLOCKED: room for 0** (2026-08-27 ~21:21): RAM 100%, only
0.06 GB truly free of 28 GB, actively swapping at ~2,148 hard faults/sec; CPU fine at 18%.
The full suite is not deferred out of preference — starting it here takes the box down along
with every other session on it. Run it when `fleet gate` clears, capped (`--maxWorkers=4`).

### Operator flag — RESOLVED, not open (corrected 2026-08-27)

Earlier passes recorded `packages/server/kanban.db` as a **schema-only stub** causing a
split-brain with the home-fallback DB. **That file does not exist any more** (checked
2026-08-27), so there is no second database to address by mistake: the CLI and the server both
open `C:\Users\pwegner\.agentic-kanban\kanban.db`, which is the real board (192 MB, live).
The `[db] opening ... (source: home-fallback)` line the CLI prints on every invocation is the
NORMAL path now, not a warning about a stub — do not re-file this as a defect.

## Archive

Passes older than 2026-09-01 have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so it records what each session believed at the time. Look there for the
2026-08-25..28 waves (#924, #807, #903, #901, #857, #874, #887, #899/#898/#897, #894, #881, the
26-ticket direct-master batch, #859's root cause, the UI overflow sweep), and before them the #680
gate-hermeticity history, the "batch 1 of N" true-state table (#691), the 2026-08-21/22/23 waves,
the adversarial review, and the hook-cost investigations.
