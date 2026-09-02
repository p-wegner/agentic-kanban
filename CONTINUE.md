# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-09-02 — #999's workspace panel had three defects in it, and they were one chain

Started as "check #999 in the UI"; the three things visible there turned out to share a
root. Filed as #1001–#1003, all three fixed on master (`a70367b1bc`, `b5be315502`).

**What was on screen.** `Context Window — 100% of context window · 2.0M / 200.0K`, and a
Timeline calling both of the workspace's sessions `Session exited with zero output (launch
failure)` — a 100-minute run with 132 tool calls and exit 0, and a 5-minute review that
committed a fix and filed a ticket.

**The chain, in causal order:**

1. **#1001** — `handleResultEvent` published the claude `result` event's `usage` as
   `liveStats.contextTokens`. That usage is the session TOTAL; occupancy is per-request.
   Verified against the session's own transcript rather than by reading the code twice:
   largest single request 124,687 tokens, stored value 2,016,340.
2. **#1002** — because of #1001 the result event drove TWO read-modify-write paths onto one
   `sessions.stats` row, and `mergeSessionStats` is a spread, so the second write won with
   what it had read. Not theoretical: **102 of the 103** sessions carrying a live-activity
   `contextTokens` had lost `inputTokens`, `outputTokens`, `model`, `durationMs`,
   `totalCostUsd` and `success`. The missing `model` is the `200.0K` denominator.
3. **#1003** — the timeline carried a SECOND `isZeroOutputSession` that inferred failure from
   absent token counts; `workspace-launch-failures.service.ts` had already abandoned that
   heuristic. #1002 stripped exactly those fields, so it fired on 100% of healthy runs.

**Verified by what.** #1003 end-to-end against the live board — `GET /timeline` returns
`session_completed / success` for both of #999's sessions, confirmed in the UI with
playwright-cli. #1001/#1002 by a new test whose negative control was actually run: reverting
the serialisation makes `broadcast-stats-write-serialisation.test.ts` fail on a dropped key.
220 tests over the impact selection plus the shared agent-stream suites are green.

**Not fixed, on purpose.** The 102 damaged stats blobs are not reconstructible (the result
event is not retained) and are display-only telemetry, so they keep their bogus values and age
out. `occupancyFromStatsJson`'s secondary fallback (`inputTokens + cacheReadTokens`) is also
cumulative for claude result stats, so the ~1968 older sessions still render a session total as
occupancy — that one has no ticket yet.

**A process note worth keeping.** `pnpm typecheck` ran green and the suite passed, and the
gate still caught a real error: the new test's `broadcast()` messages were missing
`AgentOutputMessage.sessionId`, which vitest never touches. I had typechecked *before* writing
the test. Typecheck last, not first.

**#1004 is open and is not a code defect on the branch.** The review of #999 moved the ticket
back to In Progress on a `manual`-start project, where nothing picks it up — so "stuck" was the
board doing exactly what its Start Mode says, with nothing on screen saying so.

## 2026-09-02 — the recorder now records an EMPTY selection, after being wrong about it twice

Not a ticket — a correction to #997's neighbourhood, taken on pushback from the test-impact
session and worth writing down because **I argued against it first and was wrong**.

`buildRecordArgs` omitted `--selected` when the selection was empty, on the documented reasoning
that `record` read an empty selection as "no selection recorded", so passing `--selected ""` would
make every failure read as a miss. Their new `record` inverts that, and the distinction is now
load-bearing (verified in `impact.mjs:1662`/`:1680` rather than taken on report):

- flag PRESENT, zero entries → `selectionEmpty: true`, `missed` IS computed — a failing run whose
  selector picked nothing is scored as the full miss it is;
- flag ABSENT → unknown, witnesses nothing. Unchanged.

**My first answer was that this buys the board nothing**, because the recorder passes
`--always-run` and this repo has ~170 guard suites, so its selection is never empty (measured: 171
selected against 4 changed). That is true and it is not the question. The recorder runs for EVERY
registered project with the plugin, and a small repo with no `@gate:always-run` markers
legitimately selects nothing for a docs-shaped change. The first external adopter is where the old
behaviour would have silently stopped counting — in exactly the case where the selector did worst.
Scoping an "unreachable" claim to this project, and not to the code path, is the error to remember.

The fix is one line (`args.push("--selected", …)` unconditionally); the test that pinned the old
rule was flipped, with the old reasoning kept in the comment so nobody restores it.

### The god-module gate caught the cost of the prose, and the fix is the gate's own prescription

#997's comments pushed `test-impact-outcome.service.ts` to **1014 lines**, past the 1000-line
ceiling. Trimming the reasoning would have been the wrong response — it was added deliberately.
The three row-quality classifiers (`emptyChangeSetReason`, `unmeasuredUnionReason`,
`unattributedFailureReason`) moved to `services/test-impact-outcome/row-quality.ts`: the only
functions in that module with no I/O, no tool spawn and no knowledge of where the ledger lives.
925 lines now. Re-exported from the facade, so no caller changed.

One trap worth knowing: a bare `export … from` re-exports without binding the names in the
re-exporting module's scope, and `recordGateOutcome` calls all three. It needs `import` AND
`export`, which the typecheck caught immediately.

## 2026-09-02 — #986 unblocked with real evidence, and it exposed #998: the board was discarding its own gates

**#986's blocked step is done.** It was waiting on classified discard evidence ("instrumentation
is armed; the next discard decides it"). `%TEMP%/kanban-dev.log` holds 8 `[merge-gate] …
DISCARDED` lines; six predate #979 and name no shas, but **two carry the sha pair and both are
decidable**. Attached to the ticket as an artifact; the close is test-impact's call, not ours.

| Discard | movement | verdict |
|---|---|---|
| `d0399eaa`, PASSED 374s | `base 0ad14fe6 -> 83539117` | **genuine** — a `docs:` commit landed during the gate |
| `42eb8b43`, PASSED 590s | `base f805f608 -> a0881bf8` | **genuine, and self-inflicted** — `a0881bf8` is `chore: rebuild test-impact map`, the board's own commit |

**What that decides for #986: #979's conditional half was a misreading and the exclusion must NOT
be implemented.** Its hypothesis was that the new sha would be a *sync artifact* — a
pending-wt-sync, a plumbing merge, a `syncBranchToHead` reattach. Neither is. Both new tips are
ordinary commits with real trees, so a gate that ran against the old tip genuinely did not test
what would land, and suppressing either discard would merge code no gate ever saw. n = 2 is small,
but both point the same way and that way is "leave the check alone" — the safe direction to be
wrong in.

### #998 — the finding that is not "nothing to do", and it is Done

Discard B is a ten-minute PASSED gate thrown away by the board's own housekeeping. #993 registered
the map reconciler in `BACKGROUND_SERVICES` a day ago so it runs regardless of start mode — the
right fix for the map rotting forever, and it created a committer that writes to master every 15
minutes with no knowledge of the merge path.

The pass already skipped on `lock_busy`, and **that is the wrong window**: the repo lock is held
by the merge, while the gate runs before it (the discarded attempt is literally named
`pre-lock-merge`), so the expensive 6–40 minute verification window was exactly the one the
existing skip missed.

Fixed by deferring a project's refresh while a merge is in flight FOR THAT PROJECT, keyed on the
#945 marker — durable, cross-process, written by `startMergeJob` and cleared on every terminal
transition, so it spans the whole gate including verification. Per project, not board-wide, or a
busy project would starve an idle one's map and re-create #993 through a different door. Fails
open (an unreadable marker refreshes anyway: a missed skip costs one gate, a refusal costs the
freshness #993 guarantees). Logs the deferral, because a silently-never-refreshing map IS #993.

Deferring is nearly free — the sweep repeats in 15 minutes and a stale map only WIDENS the
selection — while a discarded gate costs 20–40 minutes of re-verify.

**Verified**: two cases (the merging project is skipped and the idle one is not; the deferral
lifts by itself when the marker is deleted), plus a negative control — stubbing the condition to
`false` fails both. Impact selection green, guards-only green, typecheck green.

## 2026-09-02 — #997: the outcome ledger stops losing failures silently; one reported defect was already fixed

**#997 is Done.** Reported over ACP by the test-impact session, which consumes
`.test-impact/outcomes.jsonl`. Both halves were checked against the data before anything was
written, and the second one turned out not to be what it looked like.

### The real defect

**All 9 failing rows carry `failed: []`.** A miss is by definition a failing suite the selection
did not pick, so with no failing suite ever named, `missed` is structurally always empty and the
miss rate reads 0% no matter how bad the selector is. That number is the whole safety argument for
the `impact` gate tier (#954) and it has never had a witness.

The provable cause is not that attribution drops unattributable names — that is correct, since the
same relative path exists under every package and a name that can never match `select`'s
vocabulary would report a 100% miss rate. **The cause is that the drop was SILENT**, so a
`failed: []` row meant one of three unrelated things with no way to tell them apart: the chain
failed outside the tests; the runner named a failure but no file; or suites WERE named and all of
them were lost.

Fixed by tagging, the same mechanism `-nochange` (#963) and `-partialselection` (#967) already
use: `unattributedFailureReason` compares the pre- and post-attribution counts, the row is tagged
`-unattributed`, the attributable subset is still recorded, and it logs once. With the lost case
tagged, an UNtagged failing row with an empty `failed` set now positively means "the runner named
no file" — which is what makes the honest cases readable.

### The half that was already fixed, and why saying so matters

The same report said 7 rows have a selection but an empty change set — "a recorder path calls
select without a base, the #963 shape". **The count is right; the diagnosis is not.** All 7 are
dated 2026-08-30T21:01Z .. 2026-08-31T19:42Z; `a62efaca4b` (#963's fix) landed 2026-08-31 18:20
+0200; **every one of the 20 rows after that last timestamp carries a real change set.** Current
code passes the base and tags an empty-change-set row — the tagging has simply never had to fire.

Those 7 rows are deliberately NOT retro-tagged: the ledger is an append-only record of what was
observed, and rewriting it so the history looks better is the opposite of what it is for. The date
boundary is recorded in a comment on `emptyChangeSetReason` — the function a reader lands on when
they ask why an old row is untagged — rather than only in the ticket.

### Verified by

- Four new cases in `test-impact-outcome.service.test.ts` (40 total, green): the tag fires and
  still records the attributable subset; it does NOT fire for a runner that simply named no file
  (otherwise every typecheck/arch failure lands in the suspect bucket, which is most of them); and
  the pure reason helper, including that a negative drop reports nothing.
- Impact selection: 10 suites / 224 tests green. Guards-only green. Typecheck green.

### Still open, and it is the point of #954

Tagging makes the corpus HONEST; it does not make it big. The miss rate stays unmeasurable until
failing runs start naming suites, and the only producer that can witness a genuine miss is the
base sweep (#982), now at roughly one row a day. Nothing here changes that — it changes whether we
would be able to believe the number when it arrives.

## 2026-09-02 — #996: the raw-read ratchet follows readGuardSource, and its baseline went back UP

**#996 is Done.** `always-run-raw-read-ratchet` (#888) matched `readFileSync(<repo path>, "utf8")`
at the CALL SITE only, so a read behind a helper was invisible — the blind spot its own header
names. #994 made that concrete: routing `max-file-size`'s line-counting read through the new
memoised `readGuardSource` dropped its baseline 2 → 1. The read did not stop existing; the scan
stopped seeing it. Since `readGuardSource` is the helper every future guard is told to use, the
blind spot grew with adoption.

`TREE_READERS` now names both readers with a `hasEncodingArg` flag — load-bearing, because
`readFileSync` without an encoding returns a Buffer (nothing a newline literal could match)
while `readGuardSource` takes no encoding at all and always returns utf8 text. Everything else in
the heuristic is unchanged, including all three sanctioned outs.

**The evidence came for free and is the good kind**: turning it on immediately re-flagged
`shared/max-file-size.test.ts: 2 > baseline 1` — the guard found the read it had been blind to,
before any synthetic fixture was written. The baseline is back at 2 with the whole story in its
reason, because *a ratchet entry that DROPS after a refactor is as worth reading as one that
grows* — that is the lesson to keep from this pair of tickets.

Two synthetic fixture cases added beside the existing five, so the helper's shape is proved
red-then-green rather than argued: a `readGuardSource` read compared against a newline-bearing
literal is flagged, and a `// RAW-BYTES OK:` marker still exempts it (following a helper must not
create a shape whose only escape is to stop using the helper).

Filed on the test-impact session's advice — "a flagged-in-chat blind spot has exactly the lifetime
of this group's memory" — which was right.

## 2026-09-02 — #992: PATCH /api/projects/:id stops reporting success for work it did not do

**#992 is Done.** The route 422s a body whose fields nobody reads, with nothing applied — the
#987 defect one route over, and the #874 remedy (a `droppedKeys` list on a 200 was rejected
there because nobody reads it).

### Why this was not a copy of #987's patch

The expensive half of #987 was never the guard, it was the caller sweep — "a wrong key list here
422s a legitimate client". Redone from scratch, and it found things the issue-side sweep could
not have:

- **The client's PATCH body is NOT typed.** `buildProjectPatchBody` returns a plain object
  literal, so the "contract is a subset of what the server reads" guard proves nothing about
  what the one real caller actually sends. The guard therefore has a SECOND half that reads that
  function's own source. This is the difference from the issue side, where every client body is
  typed `UpdateIssueRequest`.
- **`defaultSkillId` was undeclared.** The server has always read it and the settings panel has
  always sent it, but it was absent from `UpdateProjectRequest`. Harmless under a permissive
  route; under a 422 it is exactly the shape of mistake that breaks every settings save. Added
  to the contract in the same commit.
- **No other caller reaches the route.** `onboarding.service.ts` calls the SERVICE (and sends a
  recognized key anyway); none of the ten MCP project tools updates fields this way; the CLI has
  no `project update`.
- **Step 4 (a narrower second endpoint, which on the issue side was the bulk route) has no
  project-side analogue for THIS body.** `PATCH /api/projects/:id/{repos,scripts,statuses}/:id`
  are different resources with their own handlers. They have the same class of hole and are
  deliberately out of scope.

### Structure

`services/project-update-fields.ts` holds the field table, and both key sets are derived from
it: `RECOGNIZED_PROJECT_UPDATE_KEYS` (what the service applies) and `RECOGNIZED_PROJECT_PATCH_KEYS`
(that plus `servicesConfig`, which the ROUTE applies). That split is the project-side form of
#987's single/bulk split — collapsing it would either make the service accept a field it cannot
apply or the route reject one it can.

`defaultBranch` stays out of the table because applying it needs an async `branchExists` call;
it is named explicitly in the recognized set, the same treatment `checklist`/`pinned`/
`milestoneId` get on the issue side.

### Verified by

- `project-update-unrecognized-keys.test.ts` (`@gate:always-run`, 7 cases) — the two contract
  halves, the service/route set split, and the field application.
- Three route-level cases in `api-project.test.ts`: the 422 asserted against the ROW (a 422 that
  had already written a field would be worse than the 200 it replaced), the ORDERING property
  (the refusal sits ahead of the `servicesConfig` validation, so a body bad in both ways reports
  the unread key and still writes nothing), and the real settings-panel body still saving.
- Impact selection: 49 suites, all green (44 server files / 327 tests, plus shared, client,
  mcp-server). Guards-only set green. Typecheck green.
- One shrink banked, not left as budget: `createProjectService` 564 → 536 NLOC in
  `function-nloc-baseline.ts` — the ratchet caught it and refused the commit until it was
  lowered.

### Not run

`packages/e2e/tests/api/projects.test.ts` was in the impact selection and needs a live server;
not run here. Nothing in the change is e2e-shaped, but that is a claim, not a result.

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
