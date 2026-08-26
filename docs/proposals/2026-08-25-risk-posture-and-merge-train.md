# Risk posture per project, and a merge train that actually runs

*agentic-kanban · design proposal · 2026-08-25. HTML twin with the same content:
`2026-08-25-risk-posture-and-merge-train.html`.*

The board was built for one careful ticket at a time on an idle machine. It now runs
100-ticket backlogs on a box that swaps. This document says where the time goes (measured),
why, and what to build — ordered so the first day of work removes the biggest stalls.

Sources: five parallel code/data investigations of the repo, the live DB, git history,
conductor logs, and `hook-cost.mjs` over the last 7 days. Every number has a file or query
behind it.

> **Fleet caveat (operator, 2026-08-25).** We are actively building out the worker fleet
> (`docs/worker-fleet.md`). Any limit on *the machine that starts agents* must therefore be a
> **placement input, not a hard gate**: a saturated board host means "prefer a remote worker",
> and only holds when no eligible worker exists (or the project is strict). Everything in §5
> is written with that rule. The bug fixes in §6 landed direct-master as `4fa6d0fee7`; the
> feature work is filed as ticket groups (see §9).

## 1. What the numbers say

| | |
|---|---|
| **1.6 GB** | usable RAM of 28 during the investigation; 13.7k hard faults/s; `fleet gate` refused even one subagent |
| **26–44 min** | one full pre-merge gate (764 files / 7,183 tests); PRD target was <60 s |
| **17.4%** | of all session wall-clock spent inside hooks (41.7 h / 7 d, lower bound) |
| **10.5 h** | median created→merged per workspace (last 30); ticket work itself ≈ 25 min |
| **~90%** | of tickets landed via direct-master, bypassing the workspace/gate path entirely |
| **0** | merge trains run in production, although the engine exists and is tested |

Three more facts frame everything else:

- **The gate is a resource failure, not a code failure.** #846 ran the gate 15 times (21–44 min
  each, ~10 h) and merged nothing; the 3 failing suites pass in 22 s on an idle box. "The retry
  is the load." While any gate holds the build semaphore, *every* monitor-mode project is held
  from starting work (`verify_gate_running`, `monitor-auto-start.ts:671`).
- **77% of merged workspaces needed more than one session**, and stopped/hung builder sessions
  average 173 min of wall-clock each — that, not the agent's work, dominates cycle time.
- **The team already does the merge train by hand.** CONTINUE.md records a direct-master batch
  that drained 26 tickets with one gate per batch, and notes the batched gate found defects no
  individual ticket's suites could see. The board cannot do this for itself.

## 2. Five root causes

### 2.1 The merge train exists but is unreachable
`merge-train.service.ts` assembles N branches onto `kanban/train/<label>`, gates the assembled
tree *once*, bisects on red, lands with `--no-ff`. But `executeQueue` only chooses it when
`recommendedStrategy === "integration-union"` — i.e. when branches *overlap* in files.
Independent branches, the textbook train input, go down the sequential path and pay one gate
each. `strategy` is not in the `POST /api/merge-queue` wire schema, and the only production
caller (`auto-merge-orchestrator.ts:368`) never asks for it.

### 2.2 Nothing reads the machine
Five independent throttles — WIP, `maxNewStartsPerCycle`, build semaphore (fixed 2),
`verify_max_workers` (pref, 1..32), git spawn slots (8) — and not one consults RAM, CPU or
swap. `agent.service.ts:542` spawns a ~520 MB `claude.exe` unconditionally. The one
machine-aware check in the repo is a Claude *hook* (`machine-capacity.js`), outside the
server. `fleet gate --json` already answers "can this box start another process?" and four
sessions in CONTINUE.md deferred work because of it — by hand.

The multiplier the semaphore cannot see: the checkout held **five agent worktrees**, each able
to run its own `pnpm test:mine` (1 vitest parent + `cpus/2` = 8 forks, uncapped —
`KANBAN_TEST_MAX_WORKERS` is set only by the gate). The board's accounting says "at most 2
gates × 2 workers" while the box may carry five agent-driven vitest fleets on top.

### 2.3 The hook chain had two bugs and one design flaw — fixed in `4fa6d0fee7`
- `scoped-vitest.js:150` referenced `overBudget`/`budget`/`budgetMessage` without importing
  them → `ReferenceError` on the **success** path → every green test run became
  `decision:"block"`.
- `remind-cleanup.js` was `alwaysRun` with no `stop_hook_active` escape → an agent that
  started `pnpm dev` could not finish until it killed its own server.
- The generated Typecheck rule had no `events`, defaulting to PostToolUse *and* Stop —
  whole-monorepo `tsc` per edit, median 5m37s × 207 calls = 47.9% of all hook time (#868).

### 2.4 Selection is FIFO by issue number
`runTodoPull` orders by `issue_number`. `issues.priority` is never read on the start path.
Strategy Bullseye weights only choose refill focus and provider — they do not reorder
anything. Hard caps of 2 relaunches and 2 merges per cycle board-wide are constants.

### 2.5 The only verdict is binary
No risk mode, no fast lane, no red-test budget. `verify_gate_strategy` weakens *scope*, never
the verdict. `scoped-base-watch` — the tier meant to let base-branch health be the backstop —
is inert: `resolveGateScoping` never branches on it, although `base-branch-health.service.ts`
is built and probing. So the default stays `full`.

## 3. Risk posture: one dial, four settings

Today an operator who wants speed must align eight prefs by hand (`verify_gate_strategy`,
`auto_review`, `review_auto_fix`, `quiesce_builders_during_gate`, `file_contention`,
`verify_max_workers`, Bullseye WIP, merge strategy). Proposal: one per-project pref,
`risk_posture_<projectId>`, resolved by one function that fans out to every consumer — the
pattern `resolveStartPolicy` established in decision 008, for the same reason: one dial is a
kill-switch and an explanation; eight prefs are a drift.

| | strict | standard (today) | fast | sprint |
|---|---|---|---|---|
| Intended for | release branches, client repos with allowlists | normal feature work | large backlog, trusted agents | greenfield / prototype, "100 tickets, go" |
| Per-ticket review | thorough | default review | review *the train*, not each ticket | none; post-hoc review ticket per train |
| Pre-merge gate | full, per ticket + train | scoped per ticket | once per train (scoped to train diff) | guards-only per train; full suite on a schedule |
| Red base | blocks all merges | blocks all merges | allowed if red set ⊆ known-red debt | allowed; debt ticket filed |
| Train size / wait | 1 (no train) | ≤4, wait ≤10 min | ≤8, wait ≤20 min | ≤12, wait until idle or 30 min |
| Builder self-tests (Stop hook) | related tests + typecheck | related tests, capacity-gated | typecheck only | off; commit-and-go |
| Contention | serialize | serialize | warn | off |
| Placement | host-derived WIP ×0.5 | host-derived WIP, remote when host saturated | remote preferred | remote preferred, host only as overflow |

**The rule that makes this honest:** a weaker posture may only weaken verification *visibly* —
the rule the gate tiers already follow. Every merge message names the posture and what was
skipped; the board shows a posture chip per project; red-debt is a first-class count, not a
silent state. Speed is bought with disclosed debt, never hidden debt.

Posture is per project, overridable per ticket (a `risk:strict` tag pins a migration ticket
to the strict lane inside a sprint project), and rendered into the Conductor's `objective.md`
so the LLM monitor and the deterministic engine agree.

## 4. The merge train as the landing path

Make the train the *default* for the auto-merge orchestrator. Four additions, not a rewrite:

1. **Reachability.** In `executeQueue`: `wantsTrain = trainEligible && (strategy === "train"
   || posture.trainMaxSize > 1)`. Add `strategy` to the wire schema and `MergeQueuePanel`.
2. **Batching window.** Collect ready workspaces until `trainMaxSize`, `trainMaxWaitMs`, or
   the host goes idle — one 30-minute gate for eight tickets instead of eight.
3. **Stacking.** Members rebase onto the train tip in least-overlap order (the queue already
   computes it) so the gate sees exactly the tree that lands. A member that conflicts with
   the tip drops to the next train (`skipOnConflict` semantics preserved).
4. **Persistence and a view.** A `merge_trains` row (label, members, state, gate evidence,
   bisect result) so a train survives a `tsx watch` restart — #893's "a merge is a POST held
   open for 40 minutes", solved for trains at the same time. A "Merge train" panel.

**Review on the train.** In `fast` posture, one reviewer session per train with the assembled
diff and member list — cheaper and better than N context-free reviews. `code-review` gains a
`{{members}}` placeholder. **Bisect stays**; in `sprint` the attribution becomes a comment on
the member's ticket plus a red-debt entry instead of a rejection.

## 5. Machine-aware admission — as a placement input

Every start decision should be able to ask *can this machine afford it right now?* — and the
answer routes work, it does not (by default) stop it.

- **Tier 0 (zero spawn):** port `capacityHold()` from `machine-capacity.js` into
  `packages/shared/src/lib/machine-capacity.ts` (`os.freemem()` with the documented 2 GB /
  skew calibration). Used by hooks per turn and as a pre-check.
- **Tier 1 (one spawn per monitor cycle):** `fleet snapshot --json` →
  `verdict.canStartAnother`, `system.headroomProcesses` (the right field for a whole
  `claude.exe`), `system.memory.thrashing`. Cached per cycle. Tool absent → Tier 0, and say so.

| Today | Becomes |
|---|---|
| `activeAgentsTarget` (Bullseye, 1..12) is the only cap | a *ceiling*; the host's share of it is `min(target, host headroomProcesses)`; the rest of the WIP goes to eligible workers. New skip reason `machine_saturated` **only** when no worker can take it (or strict) — never named "fleet", which already means the worker-fleet hold (`fleetHold`, #774/#801) |
| `KANBAN_VERIFY_CONCURRENCY = 2` | derived from spare cores/RAM at gate start; env override kept |
| `verify_max_workers` pref (1..32) | derived per run (2380 s → 1564 s at 6 workers on an idle box; 2 on a loaded one) |
| train assembles on tick | train prefers to gate when `thrashing === "none"`; a saturated host extends the batching window |
| gate quiesces *all* projects' starts | quiesce host starts only while saturated; remote placement continues |
| worker `maxConcurrency` self-declared | heartbeat carries the worker's own headroom (same snapshot shape) so placement prefers the machine with room — the fleet is the natural overflow for `fast`/`sprint` |

**Builder test runs are the dominant invisible load.** In `fast`/`sprint` the builder's Stop
hook does not run vitest — the train's gate runs it once for everyone. Only the board's own
semaphore (and remote workers) can then spawn vitest.

## 6. Hooks: bugs fixed, then adaptive

**Landed in `4fa6d0fee7`:** `scoped-vitest.js` budget import + `timeout` + `killTree`;
`remind-cleanup.js` `stop_hook_active` bail; Typecheck rule `events: ["Stop"]` at the
generator (#868); explicit `timeout` on every `settings.json` hook entry;
`check-skill-frontmatter.js` exit 2.

**Next — hooks that read posture and capacity.** Two inputs to `smart-hooks-runner`:
- **Posture**, from the ticket-context file the board already writes into every worktree:
  `strict` typecheck + related tests on Stop; `standard` the same, capacity-gated; `fast`
  typecheck only; `sprint` safety guards only. Safety guards (DB, cross-worktree) never change.
- **Capacity**, Tier 0, before *any* spawn — including generated rules, which bypass
  `capacityHold` today. A held check is inconclusive, not a block.

Also: collapse the three `Bash|PowerShell` PreToolUse entries into one runner call (3 node
cold starts → 1 per shell call); cache `check-uncommitted.js`'s transcript parse offset (it
re-reads the whole session + up to 200 subagent transcripts under a 10 s budget, twice).

## 7. Scheduling 100 tickets

- **Score, don't FIFO.** `priority × unblock_count × age / predicted_cost`.
  `buildDependencyWavePlan` has unblock counts; `budget-estimator.service.ts` has cost;
  neither feeds the start path. Bullseye weights become a term in the score.
- **Seed `coupled_with` from `touchedFilesJson`.** The contention predictor already knows
  which tickets touch the same files — the same data is a grouping proposal. Preview-first.
- **Lift the constants into posture.** `MAX_MONITOR_MERGES_PER_CYCLE = 2` / relaunches = 2
  are board-wide ceilings of ~30 merges/hour; with a train they are per-train anyway. Raise
  `activeAgentsTarget`'s clamp of 12 once WIP is placement-derived.
- **Reconcile WIP.** `wip_limit_<id>` (dependency waves), Bullseye `activeAgentsTarget`
  (monitor), `drive-preflight`'s bypass — three surfaces, one number.
- **Per-ticket "why not running".** Skip reasons are per-project tallies; persist the last
  skip reason on the issue.

*(Dropped from the HTML draft: the refill floor excluding feature tickets is deliberate per
`objective.md`, not a bug.)*

## 8. "Eventually green"

1. **A red-debt ledger.** `base_branch_health` already stores which suites are red on master
   after each merge. Promote it to a per-project `red_debt` set (suite, since-commit,
   attributed ticket, owner ticket). A `fast` train may land when its red set ⊆ ledger; new
   red is attributed by bisect and rejected (`fast`) or ledgered with a debt ticket (`sprint`).
2. **Make `scoped-base-watch` real.** Connect `resolveGateScoping` to base-health: scoped gate
   per train, full suite as a scheduled base probe (idle hours / every N trains). Probe
   failures go to the ledger, not to whichever ticket happened to be gating.
3. **A debt cap that flips posture.** `sprint` with a ledger over N entries or older than T
   degrades to `fast` automatically and says so — the shape of the profile-allowlist hold.
   Paying down debt is a ticket the refiller files, prioritised by §7's score.

Flakes: quarantine into the ledger with a `flaky` tag rather than a 45-minute re-run (#894
re-runs only failed suites; the ledger makes the quarantine durable).

## 9. Sequenced plan → tickets

| Step | What | Board |
|---|---|---|
| 1 ✅ | Hook bug fixes | landed `4fa6d0fee7` (gate durations persistence still open, in G2) |
| 2 | Host capacity as placement input; derived verify concurrency; quiesce-when-saturated; gate-duration persistence | **G2** = #908 + #909 |
| 3 | Train reachability + batching window + `strategy` on the wire; persistence + panel; train review | **G1** = #904–#907 |
| 4 | `risk_posture_<id>` resolver + fan-out; UI chip + objective render + per-ticket tag | **G3** = #911 + #912 (after #904, #908) |
| 5 | Red-debt ledger; `scoped-base-watch` wired; debt cap → posture degrade | **G5** = #915 + #916 (after #904) |
| 6 | Scored selection; `coupled_with` seeding; constants → posture; WIP reconcile; per-ticket skip reason | **G6** = #917–#919 (after #911) |
| 7 | Worker heartbeat headroom; placement prefers room | #910 (after #908; needs #895/#900) |
| — | Hooks read posture + capacity; PreToolUse collapse; check-uncommitted cache | **G4** = #913 + #914 (after #911) |

All 16 are in **Backlog** (not Todo — the current FOCUS POLICY drains Todo and does not refill) with `coupled_with` edges inside each group and `depends_on` edges between groups, so the monitor starts each group as one workspace (#661).

## 10. Risks and open questions

- **Train attribution on red** is O(k log n) gates for k bad members. Cap bisect depth by
  posture; in `sprint` attribute via the targeted re-run (#894) instead.
- **Review quality on a combined diff.** The train review prompt lists each member's
  acceptance criteria; `strict`/`standard` keep per-ticket review. Measure with
  `review-effectiveness.service.ts` before making train review the `fast` default.
- **Direct-master bypass.** ~90% of tickets skip the gate path. A fast-enough train should
  pull that work back onto the board; if it does not, the dial tunes the minority path.
- **`fleet` is a sibling tool, not a dependency.** Tier 1 must degrade to Tier 0 cleanly;
  Windows-specific snapshot fields will be absent elsewhere.
- **Two control planes.** The hand-written FOCUS POLICY outranks generated tunables and is
  invisible to the in-process engine. Render posture into `objective.md` like the tunables.
- **Not measured:** why builder sessions stop at 173 min mean; per-stage review→merge latency;
  hook tax for the invisible PreToolUse guards.
