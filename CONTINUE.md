# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

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

Passes older than 2026-08-25 have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md) (1827 lines, cut at the
2026-08-24 boundary on 2026-08-27). Nothing was re-verified or edited on the way in, so it
records what each session believed at the time. Look there for the #680 gate-hermeticity
history, the "batch 1 of N" true-state table (#691), the 2026-08-21/22/23 waves, the
adversarial review, and the hook-cost investigations.

## #924 investigated: duplicate of #893, already fully solved (2026-08-28)

Ticket asked to persist the merge job (DB row with state + gate result) or make the gate
resumable across a restart, so a `tsx watch` restart mid-gate does not throw away a 45-minute
gate run, and a gate that completed before the restart should be reusable for the same head sha.

**All of that already exists**, landed by #893 (`4ce27bb3dd fix(#893): a passing gate verdict
is persisted per head+base SHA and tier, and reused, so a restart costs seconds`), which is on
this branch's history (inherited from master, not something to re-derive):

- `packages/shared/src/schema/workspace-merge-gate.ts` + migration `0144_merge_gate_verification_key.sql`
  — a real DB table (`workspace_merge_gate`), not in-memory.
- `packages/server/src/repositories/merge-gate.repository.ts` — `setMergeGateEvidence` /
  `getMergeGateEvidence` (upsert-by-workspaceId).
- `packages/server/src/services/workspace-merge-gate.ts` — `persistGateVerdict` (writes on a
  PASS only, keyed on branchSha+baseSha+`gateVerificationKey`) and
  `reusePersistedGateVerdict` (reuse requires stage∈{verify,smoke}, both tips present and
  equal to the CURRENT tips, unchanged verification tier, age ≤ 3h). `runPreLockGate` — the
  function `mergeWorkspaceDeduped` calls on every `POST /:id/merge` — checks this BEFORE
  paying for a gate run.
- `packages/server/src/routes/workspace-actions.ts` `GET /:id/merge-status` — when this
  process has no in-memory `MergeJob` record (the literal "no merge job recorded ... in the
  current server process" case this ticket quotes), it now separately reports
  `persistedGateVerdict` and says explicitly whether a retry will reuse it.
- Tested: `persisted-gate-verdict.test.ts`, `merge-gate-evidence-pinned-before-run.test.ts`,
  `merge-job-tracking.test.ts` — 39/39 green, run directly on this branch 2026-08-28.

**Why the in-memory `MergeJob` itself (`merge-job.service.ts`) is untouched and correctly so**:
its own header comment says this is deliberate — it is diagnostic state about the live HTTP
call, not the durable record, and #893 is exactly the durable record the header points at.
Nothing in #924 survives as an open gap once #893 is accounted for.

**No code change made on this ticket.** Writing a second persistence mechanism would
duplicate #893's; the honest outcome is to close #924 as a duplicate, not to invent
busy-work. Propose-transition summary says the same.

## #807 done: coverage CI placement decided with real numbers; no floor yet (2026-08-25)

Decision recorded in `docs/decisions/016-coverage-ci-placement-and-floor.md`. Pulled actual
GitHub Actions timing for the `coverage` job via `gh run view` on this repo's own history
(no local-box guessing): ~25 minutes end-to-end on a hosted runner, same order as the
dev-box baseline from #797 — so it stays off `pull_request` (push/`workflow_dispatch` only).
**No `--min` floor**: mcp-server (48.85%) and client (48.98%) sit far below repo-wide
(71.87%), and a floor pinned to today's numbers doesn't ratchet by itself. The mechanism to
make one (a per-package, raise-only ratchet, same shape as the existing shrink-only
ratchets) is filed as **#902**, not built here.

**Bug found and fixed along the way**: `arch-gate.yml`'s `read the reports` and `merge the
four lcovs` steps had no `if: always()`, so on the common case here — a red push — they were
SKIPPED entirely, meaning the merged repo-anchored lcov (what `code-metrics` actually reads)
was never produced on a failing run, only raw per-package artifacts. Fixed by adding
`if: always()` to both steps.

**Not fully explained**: #807's own loose thread — one local run that produced no coverage
report at all despite `reportOnFailure: true` — was not reproduced against the CI history
pulled here (those runs all produced reports once patched). Left open; re-run before
concluding anything from a future missing report.

**Verified**: `docs/decisions/016-...md` cites the two real `gh run view` timings used for
the decision. No test suite exercises `.github/workflows/*.yml` directly (it's config, not
code under any package's vitest project) — verification is the CI history read plus a
by-eye YAML review, not a green test run. `pnpm check:arch && pnpm typecheck && pnpm test:mine`
run clean on this change (no source files touched).

## #903 done: gate-run semaphore, no-progress watchdog, zombie merge-job self-heal (2026-08-26)

Five commits on `feature/ak-903-pre-merge-gate-no-cross-workspace-serial`, all three ticket asks
landed plus two bugs found and fixed in self-review of the first cut:

- **`576167a354`** — the three original asks: (1) `verify-chain-semaphore.ts`, FIFO,
  concurrency 1 (`KANBAN_VERIFY_CHAIN_CONCURRENCY`), wraps the WHOLE verify chain (initial +
  install retry + flake retry) in `pre-merge-gate.service.ts`, not just each inner invocation
  under the existing build-semaphore cap of 2. (2) a no-progress watchdog in
  `setup-script.ts`'s `runSetupScript` — kills and resolves `noProgress: true` after
  `noProgressTimeoutMs` (default 15 min) of zero stdout/stderr, independent of the existing
  wall-clock `timeoutMs` (up to 3h). (3) `merge-job.service.ts`'s `getMergeJob` self-heals a
  job stuck `running` past `MERGE_JOB_ZOMBIE_AFTER_MS` (4h) to `failed` /
  `merge_job_zombied`.
- **`ef66814897`** — `noProgress` wasn't threaded into `resolveVerifyOutcome`'s retry
  decisions, so a silent-kill could still trigger a spurious install retry or get reported as a
  confirmed regression from a killed process's truncated output. Fixed to treat `noProgress`
  like `timedOut` at every retry decision point.
- **`42d7fdb6a2`** — the zombie detection never reached `mergeWorkspaceDeduped`'s
  `activeRequests` dedup map, the exact root cause named in the ticket. Fixed: a zombied job now
  drops the stale in-flight promise instead of a retry joining it forever.
- **`6a53b3975e`** — the route (`POST /:id/merge`) called `startMergeJob` unconditionally on
  every request, resetting `startedAt` (and the 4h clock) on every retry — so the clock could
  never actually reach 4h against one start time. Fixed to reuse the existing running job's
  record when joining rather than starting fresh.
- **`9546a51719`** — the route's own unconditional `startMergeJob` call still ran *before*
  `mergeWorkspaceDeduped` could read the healed zombie record, overwriting it first. Fixed: the
  route now determines "was zombied" from its own read before calling `startMergeJob`, and
  passes that through explicitly as `dropStaleActiveRequest`.

**Verified**: `check:arch` (0 errors), full `pnpm typecheck` (all packages, exit 0), and every
new/touched test file run directly and green — `verify-chain-semaphore.test.ts` +
`merge-job-tracking.test.ts` + `workspace-merge-service.test.ts` (61 tests),
`verify-retry-strategies.test.ts` (11 tests), `setup-script-no-progress.test.ts` (4 tests). 76
tests total, all passing. Full `pnpm gate:always-run` NOT run — box was RAM-bound throughout
(`fleet gate` reported room for 1 worker, 3.6 GB free).

## Velocity investigation: hook stalls fixed, merge-train/posture work filed (2026-08-25)

Proposal: `docs/proposals/2026-08-25-risk-posture-and-merge-train.md` (+ `.html` twin). Five
parallel investigations, numbers not opinions: hooks = 17.4% of session wall-clock; a full gate
26–44 min; the merge train (`merge-train.service.ts`) exists, is tested, and has run 0 times in
production because `executeQueue` only picks it for file-overlapping clusters; nothing in the
server reads RAM/CPU; selection is FIFO by issue number.

**Landed direct-master `4fa6d0fee7`** (hook bugs): `scoped-vitest.js` threw `ReferenceError` on
the green path (undeclared `overBudget`) so every passing Stop was blocked — fixed, plus a real
spawn `timeout` + `killTree`; `remind-cleanup.js` gets the `stop_hook_active` bail; generated
Typecheck rule is now Stop-only (#868 fixed at the generator — measured 207 runs / median 5m37s
per edit); explicit `timeout` on every `settings.json` hook; `check-skill-frontmatter.js` exits 2.
**Verified**: `stack-profile.service.test.ts` 32/32 single-worker, `node --check`, synthetic
`stop_hook_active` payload exits 0. **`gate:always-run` NOT run** — `fleet gate` RAM-blocked
(2.0 GB free); run it when the box frees up: `pnpm gate:always-run`.

**Filed (Backlog, 6 coupled groups, 24 edges)**: G1 merge train #904–#907; G2 host capacity as a
PLACEMENT input #908/#909 (+ #910 worker headroom, after #895/#900); G3 `risk_posture` #911/#912;
G4 adaptive hooks #913/#914; G5 red-debt ledger #915/#916; G6 scheduling #917–#919. Operator
constraint baked into every ticket: with the worker fleet coming (`docs/worker-fleet.md`), a
saturated host means *prefer remote*, and holds only when no eligible worker exists / strict.
Deliberately NOT filed: the refill floor excluding features — that is `objective.md` policy.

## #901 done: worker health is now a capability question, not a transport one (2026-08-25)

`150617ea91`. Filed and fixed from a live cross-machine report. `filterEligibleWorkers`
admitted a worker on a fresh heartbeat plus a live WebSocket — both answered by the daemon's
socket and timer layer, neither asking whether it can still launch an agent. The far end
measured the failure: an orphaned daemon spinning at 102% of a core, mute for hours, holding
an ESTABLISHED connection, handed a session that produced no launch-intent line and no process.

**The probe cost no protocol change.** #887's `probe_session` is answered by the worker's
session registry, which ALWAYS answers — including `unknown` for an id it has never held. So a
probe carrying a SYNTHETIC id is a capability check that works against every already-deployed
#887 worker: no new message type, no worker-side change, nothing to roll out.

**#887's "silence is not `unknown`" rule is preserved exactly**, via the distinction that makes
a worker-level consequence safe where a session-level one is not: an OLD worker never answers
ANY probe; a WEDGED one stops answering after having answered. Attestation (has it ever
answered?) separates them, and a never-attested worker is exempt forever.

Quarantine withholds NEW work only — never revokes, never kills, never touches held sessions —
and the sweep probes CONNECTED rather than ELIGIBLE workers, so it clears itself.

**Verified**: 13 new cases incl. the mandated regression (a never-attested worker survives 10x
the threshold untouched), plus a seam case in `placement-explain.test.ts` asserting
`agreesWithResolver`. **Checked the fix bites**: neutering the eligibility filter fails that
seam case. Green: 6 guard suites, the 4 fleet/placement suites, full `pnpm typecheck`,
god-module gate, `check:arch` (0 errors, no new warning). Full always-run set NOT run —
capped at 2 workers throughout.

**Deliberately out of scope**: a `worker_unresponsive` entry in `WORKER_EVENT_TYPES`. The
acceptance is met by `ineligibleReason`, which the panel and `worker doctor` already render.

**Not verified live** — same blocker as below: no worker can authenticate.

## #857 done: a remote claude builder was never offered board tools (2026-08-25)

`2859065305`. A vocabulary mismatch, not a config or ordering problem. `ProviderId`'s claude
spelling is `"claude-code"`; `ProviderName`'s is `"claude"`. All three predicates in
`fleet-mcp-bridge.service.ts` compared a raw `provider ?? "claude"` against NAME spellings, and
`AgentLaunchRequest.provider` is a `ProviderId` — so every remote CLAUDE dispatch, the common
case, fell to the default arm and was treated as a provider that cannot be pointed at the
bridge. No `--mcp-config`, no config file in the checkout, and the brief kept its "no board
tools here" section, which made the gap self-fulfilling.

That is what left a remote builder unable to file a ticket or comment a finding — disabling the
board-feedback routing and half the partial-refactor disclosure rule, so findings discovered
remotely were structurally likelier to be lost than findings on the host.

All three now normalize through `narrowProviderName`, the ONE place the id→name mapping lives.

**Why it survived**: every existing case passed a `ProviderName`, a vocabulary the production
caller never uses. Both new suites speak the caller's: `fleet-mcp-bridge.test.ts` +3 (ids
pinned, id/name equivalence over all four providers, default-to-claude), and a new
`remote-board-tools-claude.test.ts` that drives `agent-remote.launch` with
`provider: "claude-code"` against a real bridge and asserts on the `assign` itself — flag
present, no token in argv, config file shipped, brief rewritten to name the tools. **Checked the
fix bites**: reverting the predicate fails 6 of those cases.

**Verified**: 109 passing across the eight adjacent suites, god-module gate, full
`pnpm typecheck`. Full always-run set NOT run — `fleet gate` still RAM-BLOCKED (~3 GB free),
every run capped at 1–2 workers. **Not** verified against a live worker; see the blocker below.

## #874 done: a turn against a remote agent is routed, and the refusal stops lying (2026-08-25)

`6be65a4e36`. The ticket said which of its two preconditions actually fails was not pinned
down. It is the second, and the cause was one line from a bug this seam already fixed once.
`createAgentDispatch` writes a routing entry only in `launch`, so a session the remote
service ADOPTS on boot (#745) has none — and `forSession` answered every session-keyed query
about it from the HOST implementation, which has never heard of it and reports `isPidAlive`
false. `sendTurn` read exactly that and said the agent had exited.

- **Routing**: `forSession` now ASKS — `tracksSession?(sessionId)` on the remote
  implementation, answered as an ALIAS of its own `isPidAlive` so the two cannot disagree.
  This also repairs `kill`/`sendInput`/`closeStdin`/`isStdinOpen`/`getPid` for adopted sessions.
- **The refusal**: still a refusal (the board's copy of that agent's stdin died with the old
  process), but it names the placement and says the agent has NOT exited. `stale` stays off on
  purpose — it is the caller's cue to relaunch, and relaunching would run a second agent beside
  the one still working.
- `placementOf(sessionId)` → `"remote" | "host" | undefined`, and `undefined` rather than
  `"host"` for an id nothing tracks: falling back to host is what routing must do, but saying
  host about it would invent a fact.

**Verified**: 8 new cases in `remote-turn-after-restart.test.ts` (routing against the REAL
remote service; all three refusal arms), 86 across the adjacent dispatch/remote/turn suites,
31 across the ratchets and the two worker e2e suites, god-module gate, full `pnpm typecheck`.
**The full 152-suite always-run set was NOT run** — `fleet gate --count 2` BLOCKED (3.2 GB
free, RAM binds first); every run capped at 1–2 workers. nloc ring:
`createSessionLifecycle` 615 → 616, banked as a fourth disclosed movement with its reason.

**Still open, disclosed not papered over — #900**: a turn cannot yet REACH a remote agent
after a restart. `turnStates` is not restored by `reattachSession` (true for host sessions
too) and `adoptSession` sets `stdinOpen: false`, because the board cannot know from the DB
whether the launch kept stdin open. The worker knows; recovering it means extending #887's
probe channel to attest stdin state, with the same "silence is not an answer" rule.

## #887 done: the board ASKS the worker instead of waiting out a silence (2026-08-25)

`9064112948`. The board could not tell "the assignment never arrived" from "the agent is
working silently" and held a session that never existed for 100 minutes. Zero output is not
evidence either way — but the worker remembers every `sessionId` it was ever handed, so its
`unknown` is a FACT. New protocol pair `probe_session` → `session_probe_result`
(`unknown | running | exited`), optional on the wire, no version bump.

- **Worker half**: `worker/worker-session-registry.ts` — the ledger (bounded at 1000,
  oldest-first) plus the reply. A remembered id whose spawn threw answers `exited(null)`,
  never `unknown`.
- **Board half**: `services/agent-remote-liveness.ts` now owns BOTH ways of asking. The free
  one (a `hello` enumerates — #746) moved there verbatim; the new one asks once after
  `ASSIGN_SILENCE_PROBE_MS` (5 min) of silence.
- `unknown` → a LAUNCH failure (`kind: "dispatch"`), so #245/#751 re-places it and the ticket
  stays retryable. `exited` → `landAndFinish`. `running` → observed + reported; #883's TTL
  stays the backstop for that case.
- **Silence is NOT `unknown`** — an older worker cannot answer, so an unanswered probe holds
  exactly as before. Asserted directly, because getting this wrong would fail live sessions on
  every stale worker in a fleet.

**Verified**: 36 unit cases plus a 3-case e2e that sends a real probe over a real WebSocket to
a real worker daemon (`unknown` for an id it never received, `exited(0)` for one it ran,
`running` for one alive). Both ends are in this repo, so both are proven here. **Not** verified
against `AO-PF38Z8R8` — see the blocker below. nloc ring disclosed in
`function-nloc-baseline.ts`: `createRemoteAgentService` 609 → 609 (net zero — the hello
extraction paid for the probe wiring), `createWorkerAgentRunner` 332 → 343.

## #899, #898, #897 done: a fleet refactor and two honesty fixes in the UI (2026-08-25)

Three landed back to back while the remote worker was unavailable (see the blocker below).

- **#899** (`2226c6670c`) — `createWorkerAgentRunner` **469 → 332 nloc**, under the 406 the
  #870/#871 disclosure promised, with the baseline lowered to match. The retention leaf
  (`pushWithRetry`, `retain`, token-free persistence, `retryPending`, `suspendRetries`) is now
  `worker/worker-undelivered-retry.ts`. It extracted cleanly because it holds no runner state:
  the board `send`, the git transport and the work root are all injected. **Behaviour unchanged
  by evidence, not assertion** — `worker-push-retry.test.ts` exercises it THROUGH the runner and
  passed untouched, with 46 fleet tests green in total.
- **#898** (`edf2131885`) — the board card's profile chip stops claiming a pick the worker never
  got. `sessions.worker_id` threaded through the summary projection to
  `MainWorkspaceInfo.remotePlacement`; a remote card now reads `worker-local profile` with the
  board pick demoted to the tooltip, matching what #861 did for the detail view.
- **#897** (`ab5c5170a0`) — the timeline's 48px horizontal scrollbar. **The filed diagnosis was
  wrong**: `pctOf` clamps to 0–100, so the issue bars cannot overflow. The driver was the AXIS —
  a date label centred on the range's final tick (always exactly 100%), a 1px gridline drawn at
  `left: 100%`, and a tick container left at natural width whose shrink-wrapped box juts past its
  own origin even though the transformed label does not. Verified live at 800/900/1100/1440/1920px,
  at two zooms, and panned back a month: **overflow 0 everywhere**.

**Blocked on a human, not on us:** `AO-PF38Z8R8` has been offline since 02:21Z and needs an
interactive `claude /login` on that machine — the board cannot perform it by design (decision 012).
Until it returns, nothing is dispatchable remotely, and #895/#876 wait on it
for live verification rather than for code. #895 carries a comment recording exactly what is left
and why neither of its two routes can be honestly closed today.

**Machine caveat for all three:** `fleet gate` has been BLOCKED on RAM (~2.9 GB free) throughout,
so the full 152-suite always-run set has NOT been run for any of them — only the targeted suites
named in each commit. The four idle-looking `java` processes holding ~3.8 GB are live Gradle
wrapper→daemon chains, not stale daemons, and were deliberately left alone.

## #894 done: the gate re-runs the FLAKES, not the suite (2026-08-25)

The gate ran a full 7,183-test suite fifteen times on one workspace and merged zero times,
failing each round on ~3 timing-shaped suites that passed in 21.9s when re-run on a quiet box.
The retry was the load: a full gate run is itself what makes the next gate flake.

**What landed.** A failure on a SMALL, nameable set of suites now triggers ONE re-run of just
those suites before the merge is withheld.

- `services/verify-flake-retry.ts` — the classifier. `parseFailedSuites` pulls `FAIL <path>`
  lines out of `test-mine.mjs` output and attributes each to its `[test:mine] <pkg>:` header;
  `decideFlakeRetry` refuses to retry on a timeout, on an unscopable project, when nothing is
  nameable, when a suite cannot be attributed to a package, or above 5 suites (that shape is a
  regression, not contention).
- `services/verify-retry-strategies.ts` — the orchestration, holding BOTH retries (#169's
  install retry and #894's flake retry). It was extracted rather than inlined because
  `runPreMergeGate` had grown to 47 branches and the god-module gate correctly said restructure,
  not relocate. **Its baseline moved 43 -> 37**, so this is a net reduction, not a bump.
- `scripts/test-mine.mjs` — `KANBAN_RETRY_TEST_FILES="server:a.test.ts,client:b.test.ts"` runs
  exactly those suites. Deliberately WITHOUT `--passWithNoTests`, so a suite that fails to be
  selected fails the run instead of reporting a false green.
- The passing gate message names the retry (`GateTierInfo.flakeRetryNote`) — a level may only
  weaken verification visibly.

**Verified by:** `verify-flake-retry.test.ts` (14, incl. a real #846 output fixture),
`verify-retry-strategies.test.ts` (11, counting CALLS so a retry that could iterate fails),
`pre-merge-gate.service.test.ts` + `pre-merge-gate-install-block.test.ts` (37, unchanged),
`max-file-size.test.ts`, `console-tag-ratchet`, `always-run-marker-ratchet`,
`decision-function-purity`, `service-wiring-ratchet`, `git-exec-single-spawn`,
`wire-dto-single-declaration`, `time-injection-spelling-ratchet`, and server `tsc --noEmit`.
End-to-end: a real `KANBAN_RETRY_TEST_FILES` run executed the two named suites and nothing else.

**NOT verified:** the retry has not yet fired on a live gate — the classifier and the runner
are each proven, their junction inside a real merge is not. The machine has been RAM-blocked
(`fleet gate` BLOCKED, ~2.9 GB free) for the whole of this work, so the full 152-suite
always-run set has NOT been run; only the guards listed above were.

## #881 done: `offline` now says WHICH kind of offline, derived not probed (2026-08-25)

A worker dropped mid-session and gave a live instance of #881. The finding: **#774's event
timeline already records enough to tell the failure modes apart** — nothing needed to be
emitted, deployed to a worker, or kept in sync. Three signatures were visible in one
10-hour history, and all three come from ordering, pairing and periodicity of existing rows:

- **Ordering** — `status_change -> offline` BEFORE `disconnected` means heartbeats stopped
  while the socket was open: a blocked worker, not a bad link. The reverse order is an
  ordinary transport drop. Reading it backwards sends an operator to the network when the
  answer is on the worker.
- **Pairing** — a `connected` with no preceding close means the old socket was never
  observed closing: a respawn or duplicate dial (#858's shape). 17 of these were sitting in
  the live worker's history, invisible because nothing paired them.
- **Retry presence** — the decisive one. A crash-loop reconnects; that is what makes it a
  loop. Zero attempts after a clean heartbeat means the process exited or the machine went
  away, and waiting will not fix it.

Landed as `classifyWorkerDrop` (`packages/server/src/services/worker-drop-diagnosis.ts`), a
pure `classifyX` decision function (#585) returning one of `healthy | process-gone |
heartbeat-stall | silent-respawn | cycling | flapping | insufficient-data` plus a headline
that says what to DO. Surfaced on `GET /api/workers/:id/events` as `diagnosis`, rendered as
a banner above the fleet panel's timeline.

**Verified** (not just "tests pass"):
- 17/17 in `worker-drop-diagnosis.test.ts`, including two fixtures replaying the REAL
  observed history rather than only invented rows.
- Guard suites green: server nloc/purity/service-direction/split-responsibility/openapi x2/
  emitter-coverage (24), client theme-tokens/conventions/nloc/type-edge/api-validation (42),
  shared wire-dto/max-file-size/sub-kinds/single-consumer/barrel-safety (22).
- `typecheck` exit 0 across shared, server, client.
- **Live**: the endpoint returned `process-gone`, high confidence, on the actually-offline
  worker, and the banner rendered in the browser at 1440x900 with page overflow 0.

Two details worth keeping:
- The diagnosis is computed from **its own query** over the transport rows, never from the
  `events` the caller asked for — those honour `types`/`limit`, and a verdict derived from a
  filtered window is confidently wrong (ask for `assigned` only and it would report health).
  Confirmed live: `?limit=5` still diagnosed over the full 200-row window.
- `reconnectRegular` is `null`, not `false`, when there are too few samples — "measured and
  irregular" is a different and untrue claim. The live worker's real intervals turned out to
  be an exponential backoff ramp (7s to 27s, then a 225s gap, then nothing), which correctly
  reads as NOT periodic; the earlier 16:24-16:58 sawtooth window, in isolation, does.

Also fixed in passing: the timeline's empty state claimed connect/disconnect and assign/exit
were "not recorded yet". #801 made that false, and it was false in exactly the place an
operator looks when those are the rows they are missing.

**Still open and mine**: #894 (the gate fails on load-induced flakes and retries itself 15
times), #895 (a worker advertises providers it cannot authenticate as — the probe exists in
`worker doctor` check 7, only the wire is missing), #897 (timeline markers overflow ~48px,
needs someone who knows the intent).

**Blocked on the user, not on code**: `AO-PF38Z8R8` needs an interactive `claude /login`.
Remote dispatch itself is proven working end to end — placement, git transport, and the
incoming-ref landing all succeeded; the agent then exits in 5.5s with "Not logged in".
The board cannot perform that login by design (decision 012: credentials never leave their
machine), so no board-side change unblocks it.

## Direct-master fleet batch: 26 tickets to Done, merge queue drained (2026-08-25)

One session (direct-master, subagents in isolated worktrees, gates once per batch) took the
backlog from 54 open to ~15. Verified state, all on master `5954b57588`:

- **13 stale tickets closed with evidence** — their fixes were already on master from
  2026-08-24 direct commits, the board just never learned (#840 #844 #845 #847 #849 #851
  #853 #863 #864 #882 #883 #885 #889).
- **4 In-Review merges landed via the board** (#846 #848 #850 #860). Two gate lessons,
  both fixed: full-tier gates flake under load (machine was saturated by my own agent
  fleet — two 35-min runs lost; `verify_gate_strategy_<dev-board>` is now `scoped`), and a
  queued branch must be `update-base`d first or the gate blames it for master's history
  (#885's own thesis, observed live).
- **21 tickets implemented in worktree subagents and landed by rebase+ff** (#842 #847 #852
  #854 #855 #856 #858 #859 #861 #869 #870 #871 #875 #879 #880 #884 #886 #888 #890 #892
  #893), plus the #859/#895 exit-classification fix above and a flaky-wait fix in
  `session-lifecycle.test.ts` (#894's most frequent flake, cece2099a6).
- **Verification for the batch**: `pnpm gate:always-run` GREEN (2m41s), `check:arch` 0,
  root typecheck 0, every new/updated test file run once green. Six guards needed
  reconciliation (openapi regen, CODEX_HOME FOREIGN, worker-repo marker ladder declared,
  disclosed nloc re-baseline x5, two Stop-hook tests aged past #884's fresh-foreign
  window) — see d4b2c55b6d/6cec9b5811.
- **Follow-ups filed**: #898 (board-card summary chip for remote placements, #861
  remainder), #899 (shrink createWorkerAgentRunner back to <=406 nloc).

Still open and NOT started here: #806 (wire-contract remainder, 211 paths), #807/#831/#834
(CI/decision tickets — #834 needs a Linux CI run), #841, #843 (needs a human decision on
the reaper allowlist), #857 (verify against the #799 MCP bridge before implementing),
#872/#873 (risk-scored refactors), #876 (provider-property design), #881, #887 (session
probe — worker-daemon.ts just changed heavily, rebase carefully), #894/#895/#896 (the
parallel session's), #898/#899.

## #859's root cause: a non-zero exit is only believed for 10 seconds (2026-08-25)

**FIXED (2026-08-25, `5954b57588`)** — a non-zero exit with zero substantive output is a
launch failure at ANY duration; the window still bounds the two heuristic cases
(zero-output-clean-exit, fast-non-zero-with-output). Pinned by the #895 remote shape in
`session-exit-state-machine.test.ts`. The #895 attestation half is still open. Original
analysis kept below.

**Was: found, not fixed** — see "why not yet" at the end.

`classifySessionExit` (`packages/server/src/services/session-manager/session-exit-state-machine.ts:111`)
computes `isNonZeroExit` and then gates it behind a time window:

```ts
const withinWindow  = ctx.durationMs <= ZERO_OUTPUT_LAUNCH_FAILURE_WINDOW_MS;  // 10_000
const isZeroOutput  = !ctx.hadSubstantiveOutput;
const isNonZeroExit = ctx.exitCode !== 0 && ctx.exitCode !== null;
if (withinWindow && (isZeroOutput || isNonZeroExit)) return { phase: "launch-failure", ... };
...
return { phase: "completed", exitCode: ctx.exitCode };
```

Outside the window `isNonZeroExit` is **not consulted at all**, so an explicit non-zero exit
routes to `completed` — the path that finalizes a normal run and resets the workspace to
`idle`. That is the whole of #859: not a missing diagnosis, a discarded one.

Measured on the remote dispatch that exposed it (#895):

```
startedAt 20:50:00.692Z   endedAt 20:50:58.813Z   ->  durationMs 58,121
exitCode 1 · numTurns 1 · 0 tokens
agentSummary "Not logged in · Please run /login"
```

`58121 <= 10000` is false. Verified from source that `durationMs` is session WALL time
(`session-lifecycle.ts:573`, `endNow - startedAt`), not the agent's self-reported duration —
the agent ran 5.5s; the other ~53s was the worker cloning and checking out. Confirmed
independently by the row actually landing on `completed`.

**Why the fleet makes this reliable rather than rare.** The same failure on the host exits in
~5s, lands inside the window, and is reported correctly. Remote placement inserts clone +
checkout *before* the agent starts, so an instant failure presents as a minute-long session.
**The 10-second window assumes the agent starts when the session does, which stopped being
true when placement moved off-host.**

Suggested fix (on the ticket): let the window gate only the *zero-output* heuristic, which
needs a time bound to avoid mislabelling a long legitimate run that produced nothing. A
definite `exitCode != 0` is authoritative at any duration. Caveat recorded there too — a long
run that fails late is a "failed", not a "launch-failure", so this may want its own phase
rather than being folded into the existing one. Either way it must not be `completed`.

`#895`'s seam is `ineligibleReasonFor` (`placement-explain.service.ts:198`): five eligibility
conditions, one of which asks whether the worker *advertises* a provider and none of which
asks whether it can *authenticate* as one. Adding the sixth needs worker-side attestation
(probe locally, report the verdict not the secret, refresh on heartbeat) — #875 should land
first, since it fixes the probe this would depend on.

### Why not yet

A pre-merge gate has been running near-continuously all session (observed at 22:40, 23:05,
00:31, 00:38, 00:52, 02:37). Editing `packages/server/src` restarts `tsx watch`, which is how
#893 discarded a 39-minute gate run. **That is worth naming as its own problem: on this board
there is currently almost no window in which server source can be safely edited from the main
checkout, while `direct-master` simultaneously instructs agents to commit constantly.**

## The UI overflow sweep is complete, and the answer is "three spots, not a pattern" (2026-08-25)

All 27 registered board views swept for elements actually painting a horizontal scrollbar
(`scrollWidth > clientWidth` while `overflow-x` is `auto`/`scroll`), at **1440x900 and
1280x800**. Result: the board is clean at both widths except one filed item.

- **#862 fixed** (`69c15f5d3c`) — the detail modal used CSS multicol under a bounded height.
  Multicol does not scroll; it fragments into more columns *sideways*. 591px of overflow.
  Replaced with a grid. None of the ticket's own suspects (fixed widths, `nowrap`, wide
  `pre`, oversized `max-width`) was involved.
- **#896 fixed** (`fd4518e561`) — `truncate` on an *inline* `<span>`. `overflow` and
  `text-overflow` do not apply to non-replaced inline boxes, so only `white-space: nowrap`
  survived, which *caused* the 70px overflow it was meant to prevent.
- **#897 open** — timeline markers overflow the track (+48px @1440, +51px @1280). Possibly
  intended; a timeline is legitimately scrollable. Needs someone who knows the intent.

**Do not re-run the inline-`truncate` hunt: it is closed.** 81 files use
`<span className="…truncate…">`, but a flex/grid child is blockified, so nearly all are fine.
A runtime detector (computed `display === "inline"`) found **0 remaining instances across 22
views**. That zero was proved non-vacuous by injecting the #896 shape into a live page — the
detector caught it (0→1) and correctly ignored the same span as a flex child. So no lint guard
was added: there is nothing left for it to catch.

