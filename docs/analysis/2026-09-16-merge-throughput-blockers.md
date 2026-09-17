# Why tickets still merge one at a time — 2026-09-16

Measured on the operated board (`~/.agentic-kanban/kanban.db`, project `agentic-kanban`) over
2026-09-13 to 2026-09-16, plus a read of every throttle on the merge path in `packages/server/src`.
The question was: the test-impact budget, the `impact` gate tier, the merge train and the risk
posture were built to make merging cheap and parallel — why did three sentinel sessions still
watch one ticket merge at a time, for hours?

## 1. What the DB says happened

| Measurement (09-16, 24 h) | Value |
|---|---|
| Merge gates run | 4 (plus 3 stage-`none` refusals) |
| Gate durations | 5, 10, 12, 22 min |
| Max concurrent gates | **1** |
| Gate-minutes in the day | **51** |
| Merges landed on master | 7 |
| Tickets In Review at end of day | 18 |

Gates were cheap and few. The day went to *waiting*, not to testing. The `impact` tier and the
120 s budget did their job on the gates that ran; what they could not do is start a gate.

Merge trains: 59 rows exist, **all from 09-14 02:00 to 06:45**, all size 5. Every one ended `red`
or `abandoned` — most on `[repo-lock] timed out after 5400s`, the rest "cancelled by operator" at
11:07. No train has been assembled since. The train has never landed a ticket on this board.

Base-branch sweeps for master since 09-13: 4 green (21 to 29 min each), 2 red, 1 timeout (47 min at
100 % CPU with 2 workers), 6 `unverified` (the base clone's `pnpm install` failed). The stable
checkout stayed on `stable-20260915-3` while master ran 25 commits ahead; the fixes for the
defects the sessions kept hitting (#1166 retry-setup, #1167 backoff clear, #1168) were on master
and inert on the board being operated (`docs/two-boards.md`).

## 2. Why nothing runs in parallel — the switches

Three independent settings all say "sequential", so flipping one changes nothing:

| Switch | Value on this board | Effect | Where |
|---|---|---|---|
| `merge_strategy` | `monitor` | the auto-merge orchestrator, the ONLY production caller of the batching window and the train, is disabled | `startup/auto-merge-orchestrator.ts:142-148`, `shared/lib/merge-policy.ts:22-31` |
| `risk_posture_<id>` | `iterate` | `trainMaxSize: 1`; only `fast` (8) and `sprint` (12) ask for a train. `standard`, `strict`, `iterate` are defined as the sequential path | `services/risk-posture.service.ts:215-234` |
| `train_max_size_<id>` | `4` | read only by the orchestrator's window, which never runs here | `services/merge-train-window.ts:46` |

The proposal (`docs/proposals/2026-08-25-risk-posture-and-merge-train.md`) tabled `standard: ≤4`;
the code ships `standard: 1` with a comment deferring the raise to #905, which never happened.

## 3. Why even sequential gates are slow to start

| Throttle | Default | Effect | Where |
|---|---|---|---|
| Verify-chain slots | `min(floor((cpus-2)/2), 3)`, bounded by `floor((freeGb-2)/3)` | below ~5 GB free this derives **1**: strict serialisation of gate, smoke, E2E lane and base probe. #1160's widening is inert exactly when merges pile up | `shared/lib/machine-capacity.ts:364-420` |
| Gate host floor | on, 2 GB | gate `HELD`, merge deferred to next 4-min cycle, ticket unchanged | `services/gate-quiesce.ts:162-199` |
| Base probe sequenced before the gate | posture `iterate` = 24 h interval | a due or in-flight probe (clone + install + up to 45 min verify) runs FIRST, inside the ticket's critical path | `services/gate-base-health-sequencing.ts:94-152` |
| Sweep refused while any gate runs | always; operator `ignoreRecency` deliberately does NOT override it | with 18 In Review a gate is almost always running, so a sweep verdict almost never lands, so `pnpm promote` refuses (#1165) | `services/base-branch-health-reprobe.service.ts:177-186, 335-343` |
| Monitor merges per cycle | `iterate` = 2, cycle 4 min | upper bound only; never reached | `startup/monitor-cycle.ts:805-842` |

Observed live on 2026-09-16 21:51: the monitor started #1164's gate the second the board booted, and
the promotion's reprobe request was refused `gate_running` every 15 s from then on.

## 4. Why tickets do not even reach a gate

| Precondition | Escape today | Where |
|---|---|---|
| Setup-failure latch: one `failed` setup row withholds the gate forever (stage `none`, 2 ms) | #1166 `POST /:id/retry-setup`, on master, NOT on the operated board | `services/pre-merge-gate-setup-failure.ts:22-36` |
| Nothing rebases an In-Review branch; a 12-15-commit-stale branch fails the gate on its own reversion diff | manual `POST /:id/update-base` (#1169 open) | `routes/workspace-actions.ts:740-745` |
| Monitor gate recall: a branch red at sha X is skipped until it moves | with no auto-rebase it is parked | `services/monitor-gate-recall.ts:31-60` |
| Merge backoff 10 min doubling to 2 h, ceiling 6 identical failures, then never expires | #1167 clear door, manual, on master only | `services/merge-backoff.service.ts:43-72` |
| Red base blocks every merge (`redBasePolicy: block` for `iterate`) | a green sweep, which §3 refuses while a gate runs | `services/workspace-merge-gate.ts:453-570` |
| Dependency gate: `depends_on` an In-Review ticket freezes the dependent | the blocker merging | `services/autopilot-status.service.ts:168-173` |

On 09-16, `blockedByDependencies: 4` resolved to #1142/#1143 → #1141 (setup latch) and
#1146/#1148 → #1145.

## 5. Designed but not implemented

- §4.3 stacking (rebase members onto the train tip in least-overlap order). `assembleMergeTrain`
  merges `--no-ff` in list order and drops conflicts.
- Train as the orchestrator default for `standard`.
- Review on the train (`reviewMode: "train-only"` exists in the struct; no train-scoped reviewer).
- Auto-rebase of stale In-Review branches (#1169).

## 6. What would change the number

Ordered by expected effect on merges per day, cheapest first:

1. **Promote on a timer, and let the sweep win over a gate.** The sweep is a 25-min run that
   unblocks promotion of every landed fix. Give the reprobe priority: hold new merge starts while a
   sweep is due (the mirror of today's rule), or let the operator `ignoreRecency` also override
   `gate_running`. Today's rule makes the sweep the lowest-priority job on a box that is never idle.
2. **Rebase before gating** (#1169): `update-base` as the first step of every merge attempt. Removes
   the reversion-diff failures, the gate-recall parking and most 6/6 ceilings.
3. **Un-latch setup failures** by re-running setup automatically before refusing (the #1166 door
   called by the gate itself, not by an operator).
4. **Make the train reachable**: `merge_strategy = merge_queue` for this project, posture
   `standard` with `trainMaxSize 4` as the proposal tabled, and fix the 09-14 failure first: every
   train died on the 90-min queue repo lock, so a train must not wait on a lock a single merge holds.
5. **Derive verify-chain slots from measured gate RAM**, not a 3 GB constant, once a gate's real
   peak has been measured on this box (not done here).

None of these is filed yet; §6 is the proposed ticket set.

## 7. What landed — addendum 2026-09-17

All of §6 items 1 to 4 are on master and live on the operated board (`stable-20260917-2`,
master `bdba072b7a`), via four promotions on 2026-09-16/17:

| Item | Landed as | Live evidence |
|---|---|---|
| Sweep wins over gates | #1165 (explicit reprobe overrides `gate_running`) + explicit probe at gate priority, no yield; test #1178 | run 3 sweep green in 21 min on a box with holds; run 5 sweep green with gates running |
| Rebase before gating | #1169 refusal + rebase-first through `update-base` | queue refused #1166 only after a real conflict |
| Un-latch setup failures | #1172 (deps present overrides stale verdict); #1166 `retry-setup` was already on master | — |
| Train reachable | `merge_strategy = merge_queue`; #1180 per-repo partition of a release; #1181 live-train registry + land veto | 01:20Z: `Merge branch 'kanban/train/qmu4t981aab'` landed #1176 + #1177 after bisect; reconciler logged `skipping train … live in this process` at 9/19/29/39 min instead of superseding |

Still open: #1182 (impact-map rebuild holds the shared merge lock), #1183 (boot pass drops
members when two stranded rows share a project), §6 item 5 (slot derivation, needs a measured
gate peak). The 09-14 train deaths are explained by #1181: the reconciler's own resume path
abandoned the live row before re-assembling, every 10 minutes.
