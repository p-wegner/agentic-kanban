# The integration risk ladder

_How much a merge must prove, and where the rest of the proof happens, per risk posture.
The posture table in `packages/server/src/services/risk-posture.service.ts` is the source of
truth for the values; this page explains the ladder and the release-candidate model that
decision 019 puts under it. Read decision 017 for how one dial fans out, and
`docs/two-boards.md` §8 for the promotion mechanics._

## The idea in one paragraph

Every integration style answers the same three questions: **what does a merge prove**, **what
does the full suite prove and when**, and **who fixes red, where**. The ladder orders the
answers from "prove everything before landing" to "prove only your own change, prove the rest
on the release candidate". Higher rungs pay more per merge and never see a red base; lower
rungs pay per change and accept a red base, because the release, not the merge, is where green
is owed. The rung is a project setting (`risk_posture_<projectId>`), overridable per ticket
with a `risk:<level>` tag.

## The rungs

| Rung | Merge proves | Full suite runs | Red base | Review | Best for |
|---|---|---|---|---|---|
| **strict** | full suite, every merge | at every merge | blocks every merge | thorough, per ticket | client deliveries, a repo with no other safety net |
| **standard** | full suite, every merge | at every merge; master swept half-daily | blocks | standard, per ticket | the default; a repo that has not chosen |
| **fast** | scoped suite once per train (up to 8) | per train; master swept | allowed when it is known debt | the train, not the ticket | a sprint with a trusted crew |
| **sprint** | guards only, per train (up to 12) | never at merge; master swept | allowed, files a debt ticket | none | a throwaway or a spike |
| **iterate** | test-impact selection + the guard floor | nightly on master, misses recorded | allowed; files a heal ticket per failure signature, never holds the window (#1233) | standard, per ticket | a board that wants narrow gates but still a green master signal |
| **flow** | typecheck + test-impact selection + the diff's own new tests; no guard floor | **on the release candidate only** | never blocks; reported and counted | standard, per ticket | the fastest honest cycle: this board's own development |

Two rules hold on every rung:

- **A weaker rung may only weaken verification visibly.** The posture's `summary` names what
  it skips, and the gate's pass message prices what ran (`selection kept 2 suites/~3s est,
  +12 guard suites`). A bare "passed" is never emitted.
- **A green selection is not a green suite.** The impact selection is a ranked guess. What it
  drops is measured by the miss-rate join (#1234): a suite that the release candidate finds red
  and no intervening merge gate ran is a miss, attributed to the merges that could have caused
  it. The number is what decides whether a rung may become a default.

"Merge proves" is the gate the merge path runs. The gate at the end of a clean review is a
separate run: on `strict` and `standard` it is the same full gate, on `fast`, `sprint`, `iterate`
and `flow` it is typecheck only (#1260), because those rungs gate again at merge and a second
test run per ticket only doubled the cost.

## What else a rung sets

The gate is one field of the posture. The same dial sets how work is batched, how fast the
monitor lands and relaunches, what a builder checks before it stops, and where it runs. Values
from `postureForLevel` in `risk-posture.service.ts`:

| Level | Review-exit gate | Train window | Merges / relaunches per cycle | Builder self-check | File contention | Placement |
|---|---|---|---|---|---|---|
| strict | full gate | none (1) | 1 / 1 | tests + typecheck | serialize | host, half the box |
| standard | full gate | none (1) | 2 / 2 | tests, capacity-gated | serialize | host preferred |
| fast | typecheck | 8, 20 min | 4 / 4 | typecheck only | warn | remote preferred |
| sprint | typecheck | 12, 30 min | 8 / 6 | none | off | remote preferred |
| iterate | typecheck | none (1) | 2 / 2 | tests, capacity-gated | serialize | host preferred |
| flow | typecheck | none (1) | 2 / 2 | tests, capacity-gated | serialize | host preferred |

"Train window none (1)" means the posture does not ask for batching. The auto-merge window still
collects ready branches, with its own defaults: up to **4** members, released after **10 min**
(`DEFAULT_TRAIN_MAX_SIZE`, `DEFAULT_TRAIN_MAX_WAIT_MS` in `merge-train-window.ts`). An explicit
`train_max_size_<id>` / `train_max_wait_ms_<id>` wins over both the posture and the default. A
release of several branches on one repo and base is gated as one train; branches on other repos
or bases ride separately. So a `flow` project does run trains of up to 4 unless it pins
`train_max_size_<id> = 1`.

Per-field overrides that a project can set on top of its rung: `verify_gate_strategy_<id>` (the
tier), `guards_at_merge_<id>`, `red_base_policy_<id>` (softer direction only),
`test_impact_budget_<id>`, `verify_max_workers_<id>`, `verify_timeout_ms_<id>`,
`promote_cadence_<id>`, `heal_target_<id>`, `queue_flush_<id>`. A ticket's `risk:<level>` tag
replaces the whole rung for that ticket.

## The resource side: what a gate costs and who waits

Risk decides what a merge must prove. Resources decide how many proofs the box can run at once,
and therefore how long a ready branch waits. On one 16-core / 28 GB box with several builders,
the gate, not the builders, is usually the bottleneck.

**Verify chains.** Every gate, train gate and sweep is a verify chain. The box admits at most
**3** at once (`MAX_VERIFY_CHAIN_SLOTS`), each needing **3 GB** free over a **2 GB** reserve and at
least 2 workers, on its own CPU partition (`machine-capacity.ts`, #1160). A chain that does not
fit is queued, never started on a saturated box, because a squeezed chain runs at 1/N speed and
starves its neighbour (#949). With 6 GB free the box runs 2 chains, not 3.

**The cost of one gate** is `check:arch` + `typecheck` (~1 min + ~10-60 s, `KANBAN_TYPECHECK_WORKERS`
default 2) plus the test step. The test step is bounded by `test_impact_budget_<id>`: since #1260
the budget caps the whole selection, the diff's own tests charged first and never cut, then the
rest in score order until the next suite does not fit; union entries rank last. Caveat (#1262):
the per-suite durations in the impact map are in-test time only, without vitest's per-file
startup, so a 120 s budget still runs several minutes of wall clock.

**The cost of one ticket** is (gate runs per ticket) × (gate cost). Before #1260 the low rungs paid
two full test runs per ticket, one at review exit and one in the train. Now they pay one.

**What yields to what.**

| Chain | Class | Yields? |
|---|---|---|
| merge gate, train gate | gate | never |
| review-exit gate | gate | never (typecheck only on the low rungs) |
| scheduled base sweep | background | yes: gives up its slot to a queued gate and discards its run (#989) |
| sweep someone waits on (`pnpm promote`'s reprobe) | background, explicit waiter | no (#1256) |

**Host health holds.** A gate is held, not failed, when `%TEMP%` enumerates too slowly or holds
more than 250,000 entries (`temp-health.ts`, #1056). Drain with
`node scripts/sweep-loose-test-db-files.mjs --apply` and `node scripts/sweep-temp-dirs.mjs --apply`.

**Builders.** WIP is the Bullseye's `activeAgentsTarget` (#1102); the monitor holds starts when free
RAM falls under its capacity tier (`CAPACITY_HOLD` in `scripts/board-monitor/objective.md`). The
posture's placement bias sends builders to remote workers where one attests the profile
(`docs/worker-fleet.md`). More builders only helps while the gate keeps up; past that point they
add queue depth, and the flush (below) is the valve.

## When the queue goes wrong

Each mechanism below exists because a real stall happened. Together they decide whether one bad
branch costs one branch or the whole queue.

- **Bisect with a control arm.** A red train first gates the bare base. Green base means a member
  broke it: the train splits into halves and gates each. A member that is red on its own is
  reported as `gate failed for this branch alone (bisected out of the train)`. Every red train
  gate logs its members and failing suites (`train gate RED …`).
- **Siding.** A member bisected out waits on the siding until its branch head moves, then rejoins
  the next train. It does not block the rest.
- **Same-failure breaker (#1207).** Three consecutive gate runs with the same failure signature
  trip it. When all three are one branch's own failure, only that branch is held (a
  `workspace_merge_hold` with reason `auto-merge breaker: …`, released when its head moves, on
  `DELETE …/merge-hold` or `POST …/auto-merge/resume`); the rest of the project keeps merging.
  Only a failure not attributable to one branch pauses the project. Before this change one bad
  branch froze a whole night's queue.
- **Deterministic guard failures stop re-gating (#1230).** A guard that fails the same way every
  time is not retried as a flake.
- **Base moved during a gate (#243).** A verdict is only trusted for the base it ran on. If the
  base moved only by verdict-neutral paths (Bullseye `objective.md` syncs, `CONTINUE.md`,
  `BACKLOG.md`, `docs/state.md`, proposal and analysis docs; `base-move-relevance.ts`) and the
  branch touches none of them, the verdict is kept and re-keyed. Any other move, or any git error,
  discards it. Every Bullseye save commits to master, so without this each save threw away every
  gate in flight.
- **Stale-base recovery (#1258).** A builder that finishes on a moved base is rebased and sent to
  review whenever auto-merge is effectively on, whoever owns the merge.
- **Review-loop breaker.** A workspace with 5 sessions in review is closed to stop a loop. It can
  catch a workspace that passed review and is mid-merge; `pnpm cli -- workspace reopen <N>`
  recovers it (#1259 narrows the breaker).

## Choosing a rung by risk and resources

Two questions pick the rung: **must master itself be green** (risk), and **can the gate keep up
with the builders** (resources).

| | Gate keeps up | Gate is the bottleneck |
|---|---|---|
| **Master must be green** (client repo, direct deploys) | `standard`; `strict` for release branches | `standard`, fewer builders; add verify capacity (remote workers), not a weaker rung |
| **Only releases must be green** (promoted rc, local-first) | `iterate` (nightly master sweep as a signal) | `flow`, trains on, a daily `promote_cadence_<id>`; flush when the pressure signal says so |
| **Nothing is released yet** (spike, prototype) | `fast` | `sprint` |

Signs you are on the wrong rung: ready branches older than one cadence, the same gate discarded
repeatedly, or gate minutes per day above the box's chain-hours. The delivery view's queue
pressure (#1246) shows all three.

## The release-candidate model (decision 019)

On `iterate` and `flow` the drawbridge is the release, and the release is a branch:

```
master  ──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──▶   (never waits)
            \                         \                 ↑
             rc/20260925 ──sweep──✓──▶ tag stable-…     │ merge-back (board workspace, normal gate)
                                       \                │
              rc/20260926 ─sweep─✗─heal─●─sweep─✓─▶ tag ┘
```

1. **Cut.** On the cadence (or `pnpm promote` by hand) the board cuts `rc/<date>` from master's
   tip. Master keeps merging; nothing on it waits for anything below.
2. **Sweep the candidate.** The base-branch sweep runs on the rc (a throwaway clone of the rc,
   the full `verify_script`, no scoping env; #1231 stamps the row with the mode it ran in). The
   rc is the only thing the sweep has to be green for.
3. **Green: promote.** The rc sha is tagged `stable-<date>` and deployed exactly as today
   (build, migrate, restart, smoke, rollback on failure). The rc is then merged back into master
   through the board, which is a no-op when nothing was healed.
4. **Red: heal on the candidate.** The board files one `heal` ticket per distinct failure
   signature, based on the rc branch and merging into it. The heal builder runs the same narrow
   gate as any builder plus the failing suites named in the ticket. When the rc goes green, step
   3 runs, and the merge-back carries the fix to master. A candidate red for more than one
   cadence is abandoned; the next cut carries the open heal ticket forward.
5. **Regular cadence keeps the red small.** With a daily cut, any red suite is at most a day of
   landings old, and the heal ticket names those landings. Skipping releases is how red
   accumulates; the cadence is the control, not the gate width.

What this buys: the stable board only ever runs a sha that passed the full suite, and no
merge ever waits for that suite. What it costs: two branches can be red at once (master and
the rc), and the heal work is real work that the cadence makes visible instead of deferring.

## What a builder does on the low rungs

- Work in your worktree on your branch, against whatever master was when you branched.
- Run the impact selection, not the package suite: `node .claude/skills/test-impact/tools/
  impact.mjs select --min-score 1.0 --format vitest`, then what it prints, plus your own new
  tests. Make those pass. That is your gate.
- Mark ready. The board's merge gate re-runs the same selection on the merged tree plus
  typecheck, and lands the branch. A red suite you did not touch is a finding for the heal
  ticket, not your task. Do not widen your run to prove master.
- Never move the base branch, never rebase onto a remote ref, never fix master from a
  worktree. The guard from #1237 blocks the first two; the third is what heal tickets are for.

## Queue pressure: the flush (decision 020)

When builders outrun the gate, the queue itself becomes the blocker. The flush (Yegge's "land it
all and fix it after") is the merge train with no cap, a gate of `check:arch` + `typecheck` only,
no bisect, and the suite deferred to the heal target. It is available on `fast`, `sprint`,
`iterate` and `flow`, refused on `strict` and `standard`, and it is loud: a `flush/<date>-N` tag,
`source: flush` on the ledger row, a comment on every member ticket, a badge on the delivery chip.

Healing after a flush does not require an rc. `heal_target_<id>` picks the shape:

```
rc      master ──flush──●──●──●──▶          master ──flush──●──●──●──●──▶
                        \                                  │ sweep master, heal tickets
                         rc/<date> ─sweep─✗─heal─✓─▶ tag ─┘  based on master, land = healed
```

Under both shapes the base-red veto holds nothing and trains keep landing while heal tickets are
open; the flush record answers "did it happen", "is it healed", "is the healed state on master".
The trigger is measured first (queue depth, oldest age, arrivals vs gate runs), then manual, then
`auto`. Tickets #1246–#1249; the rest is decision 020.

## What the operator watches

- The delivery view (and `pnpm cli -- tracker`): master's last verdict, the rc's verdict, the
  inherited-red count, the open heal tickets, and the impact miss rate.
- `pnpm promote --dry-run`: which rc, which sweep row, its scope, and the ledger evidence
  since the last green (labelled as the weaker measurement it is).
- The Sentinel's one line names the rc state when a cadence is configured.

## Where each piece lives, and what is still a ticket

| Piece | Status |
|---|---|
| Posture dial and the five existing rungs | landed, decision 017 |
| Guard-floor deferral under `iterate` / `flow` | landed, #1232 — `guards_at_merge_<id>` / `KANBAN_TEST_GUARDS=intersecting`; every bare marker now carries a reviewed `when:` or `always` spelling |
| Posture-aware red-base veto, heal ticket under `iterate` | landed, #1233 |
| Miss-rate join and gate durations in the ledger | landed, #1234 — `.test-impact/misses.jsonl`, `impactMissRate` on delivery + tracker, the `miss rate` line in `promote --dry-run` |
| Sweep env scrub and scope stamp; `promote` refuses a non-full green | #1231 |
| Deterministic guard failures stop the re-gate loop | #1230 |
| RC branch promotion and the cadence | landed, #1238 — `pnpm promote` cuts `rc/<date>[-N]` from master's tip and gates THAT (`?branch=` on the health/reprobe routes, `probeBranch`); green tags the rc sha, red records the failing suites in `<stable>/.kanban/rc-state.json` and stops with the heal instruction; `promote_cadence_<id>` (`off` \| `daily@HH:MM`) fires the same run from the scheduler, and a red rc older than one cadence is abandoned for a fresh cut. The merge-back is a board workspace since #1239 |
| Heal-on-candidate and the merge-back | landed, #1239 — a red rc sweep files ONE `heal` ticket per failure signature PER candidate (`base-health-heal:<project>:<sig>:<rc>`, refreshed on the same red, every posture; `heal_review_posture_<id>` pins its `risk:` tag); its workspace branches from the rc, `update-base` rebases onto it, the merge lands on it, and the gate forces the rc's red suites (`KANBAN_TEST_NEW_FILES`); a train never mixes bases; every merge/review/rebase/diff path reads the base through `resolveWorkspaceBase` (`workspace-base-read-ratchet.test.ts` pins the 32 hand-spelled reads that remain, shrink-only). Green promotes, then `promote.mjs` POSTs `…/rc/merge-back` for a board workspace (branch = the rc, base = master, normal gate) whose landing closes the heal tickets — the hand command is printed only when no board answers; an abandoned rc's open heal tickets and their workspace bases move to the next cut (`…/rc/retarget`). Delivery view, `GET …/rc` and the tracker carry `openHealTickets` and `inheritedRed` |
| The `flow` posture | landed, #1240 — `gateTier: impact`, `redBasePolicy: report`, `sweepIntervalMs: null` (the delivery view says "full suite: release candidate only"), guards `intersecting` at merge; the rungs table above is ratcheted against the resolver by `integration-risk-ladder-doc.test.ts` |
| Queue-pressure signal, flush record and its observability | landed, #1246; activity-log entry, Sentinel line and true `readySince` in #1253 |
| Flush train mode (no cap, arch + typecheck, no bisect, siding, tag, ledger source) | landed, #1247 |
| Flush trigger: pref, Flush action + CLI, `auto`, rails | landed, #1248 |
| Heal target after a flush: `rc` or `master`, merges keep flowing | landed, #1249 |
| A sweep someone waits on does not yield its slot | landed, #1256 |
| Review-exit gate is typecheck only on the low rungs; the budget caps the whole selection | landed, #1260; gate messages still price the pre-cap selection (#1261), durations exclude vitest startup (#1262) |
| Stale-base recovery under the merge queue | landed, #1258 |
| Same-failure breaker holds one branch; red train logs its suites; verdict-neutral base moves keep the verdict | landed on master 2026-09-27 (`board fix:` commits) |
| Review-loop breaker spares a passed, mid-merge workspace | #1259 |

A ratchet keeps this table honest: `integration-risk-ladder-doc.test.ts` (#1240) fails when a
posture level exists in the resolver (`RISK_POSTURES` and the `case` labels of
`postureForLevel`) and not in the rungs table above, or the other way round. A rung is a row
whose first cell is `**<level>**`.
