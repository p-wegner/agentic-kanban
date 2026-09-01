# Verification cadence: fast gate during development, full suite on a schedule

**Status:** implemented (#982/#983/#984)
**Date:** 2026-09-01
**Problem:** active development is severely slowed by a full-suite verification gate on every merge.

## The goal, stated as a policy

Split verification into two questions that today are answered by one mechanism:

| Question | Should run | Today |
|---|---|---|
| *May this branch merge?* | fast, narrow, per merge | full suite, minutes to tens of minutes |
| *Is the codebase actually healthy?* | full suite, on a schedule | conflated with the above |

A narrow per-merge gate is only honest if something else runs the full suite regularly **and
feeds what it learns back**. That backstop is what makes the fast path safe, and it is also what
turns the impact selection from a permanent guess into a measured one.

## What already exists

This proposal is mostly wiring, not construction.

| Piece | Where | State |
|---|---|---|
| `impact` gate tier — selection instead of `vitest related` | `services/pre-merge-gate-tier.ts` (#956) | built, **strictly opt-in, never a default** |
| `RiskPosture` — per-project bundle of gate tier + review mode + base-red policy | `shared/lib/risk-posture.ts`, `services/risk-posture.service.ts` (decision 017) | built, 4 levels |
| Periodic full verify of the base branch | `startup/base-branch-health-reconciler.ts` (#491) | built, **every 30 min, per project, not posture-driven** |
| Impact-map refresh, single-writer | `startup/monitor-test-impact-map.ts` (#952) | built |
| Outcome ledger + miss-rate computation | `services/test-impact-outcome.service.ts` (#954) | built |

Notably, the `sprint` posture's own description **already promises** "gate runs guards-only per
train, **full suite on schedule**". The intent is written down; the schedule half was never
implemented as a posture-driven cadence.

## The three gaps

### A. The scheduled full run feeds nothing back — the missing wire

`recordVerifyGateOutcome` has **exactly one caller**: `pre-merge-gate.service.ts:534`.

So when the base-branch sweep runs the full suite and finds a failure, nothing compares that
failure against what the impact selection *would* have chosen, and nothing is appended to
`.test-impact/outcomes.jsonl`. The miss rate therefore stays unmeasured — and an unmeasured miss
rate is precisely the reason #956 forbids `impact` from being anyone's default.

This is circular, and it is the single highest-value fix here: **the mechanism that would justify
the fast gate is the one that was never connected.** It costs nothing and weakens nothing,
because it only ever *adds* observations.

### B. Cadence is a module constant, not a policy

`BASE_HEALTH_DEFAULT_INTERVAL_MS = 30 * 60 * 1000` is the same for every project, regardless of
posture. Two consequences:

- It is far too *frequent* to be a nightly safety net. That module's own header documents the
  incident: a full `check:arch && typecheck && test:mine` for ~25 registered projects, serially,
  competing with a developer's own suite — the likely source of `Worker exited unexpectedly`
  crashes and 5s guard-suite timeouts that read as unrelated test failures.
- It is not expressible per project, so "nightly for this repo, per-merge for that client repo"
  cannot be said at all.

### C. `impact` is unreachable from a posture

`RiskPosture.gateTier` is deliberately a three-value union (`full | scoped | scoped-base-watch`)
that excludes `impact`, so no posture can select it. Reaching it requires setting the
finer-grained `verify_gate_strategy_<projectId>` override by hand — which is exactly the
"hand-align N prefs" problem decision 017 exists to remove.

## Proposed design

Extend the existing posture bundle rather than inventing a parallel knob — decision 017 already
established the posture as the one per-project dial, and this is another field of the same
decision.

### 1. Add a `sweep` cadence to the posture

```ts
interface RiskPosture {
  gateTier: "full" | "scoped" | "scoped-base-watch" | "impact";   // + impact
  sweepIntervalMs: number | null;   // null = no scheduled sweep; the per-merge gate is the check
  // ...existing fields
}
```

`base-branch-health-reconciler` reads the interval **per project from the posture** instead of the
module constant — through `resolveBaseSweepIntervalMs`, never `posture.sweepIntervalMs` directly.

**The sweep is OPT-IN, and choosing a posture IS the opt-in.** `resolveBaseSweepIntervalMs` returns
`null` for any project whose posture is not an explicit `risk_posture_<projectId>` pref
(`source !== "risk_posture"`), so an imported repo nobody is developing spends no background
compute at all. That needs no new knob: `RiskPosture.source` already distinguishes an explicit
pref from the fallback. A per-ticket `risk:` TAG does not opt a project in either — a tag is
scoped to one workspace and cannot speak for a project-wide periodic sweep.

This is also the larger half of gap B's fix. Reducing ~25 projects × 30 min to a handful ×
6–24 h is most of the load this file set out to remove. Its existing persisted-recency guard (`isBaseHealthProbeDue`, #699/#712) already
makes a longer interval safe across restarts — no new machinery.

### 2. Add an `iterate` posture, and make it this board's default

| Posture | Per-merge gate | Full-suite sweep | Intended for |
|---|---|---|---|
| `strict` | full | 12 h | release branches, client repos with allowlists |
| `standard` | full | 30 min | today's default; unchanged |
| **`iterate`** *(new)* | **impact** | **24 h** | **active development — this board's own setting** |
| `fast` | scoped | 6 h | |
| `sprint` | scoped-base-watch | 24 h | (makes its existing promise true) |
| *(no posture chosen)* | full | **never** | every imported project — see the opt-in rule below |

This is the risk/speed/deployment axis: `strict` for anything with a real deployment or a
compliance story, `iterate` for a local-first repo where a defect caught within 24 h costs a
rebase and nothing else.

### 3. Close the loop — and the trap in doing it naively

The obvious wiring **does not work**, and the codebase says so explicitly. `recordGateOutcome`
derives the change set by running `select <base> --json --always-run`. A base sweep verifies the
base branch *at its own tip*, so with no base ref (or with base == HEAD) the change set is
**empty**, and the row is tagged `-nochange` with this log line:

> recorded a gate outcome with an EMPTY change set … the selection it names is the always-run
> baseline, not this branch's, so the row is tagged `source=…-nochange` and **must not be counted
> toward the miss rate**

So a naive wire would append rows that are excluded from the very measurement they exist to
produce. `emptyChangeSetReason` is there precisely to catch this.

**The base that makes the row meaningful is the sha of the last GREEN sweep.** Then the change set
is "everything that merged since we last knew the base was healthy", and the question the row
answers is the one that matters:

> Of the suites that failed tonight, how many would the `impact` selection have chosen for the
> diff that accumulated since the last clean run?

Concretely, the sweep:

1. looks up the last `green` row's sha for the project (`base_branch_health` already stores
   `sha` + `outcome`; needs a small `getLastGreenBaseBranchHealth` accessor — `listBaseBranchHealth`
   can serve it today),
2. runs the full suite as it does now,
3. records via `recordVerifyGateOutcome` with `baseBranch = <last green sha>` and a distinct
   `source` (e.g. `base-sweep`; the ledger's `source` field already exists and defaults to `ci`),
4. skips recording entirely for `timeout`/`unverified` — inconclusive by the same contract
   `recordVerifyGateOutcome` already applies to a killed gate run,
5. leaves the map refresh to #952's existing monitor phase.

A first-ever sweep, or one with no prior green row, has no meaningful base — it should record
nothing rather than produce a `-nochange` row that dilutes the corpus.

After a few nights, `impact.mjs stats` reports a **measured** miss rate. That is the corpus #954
was always meant to produce, and #956 named as the precondition for promoting the tier.

## The line this crosses, stated plainly

`pre-merge-gate-tier.ts` is explicit:

> **`impact` IS STRICTLY OPT-IN AND IS NOT ANY PROJECT'S DEFAULT** — deliberately… #954's ~50-run
> corpus gates the PROMOTION of this tier to anybody's default — a separate, later decision —
> rather than its existence. `DEFAULT_VERIFY_GATE_STRATEGY` stays `full`, and no risk posture
> yields `impact`.

Both halves of that (a posture yielding `impact`; a project defaulting to it) are things this
proposal does. That is a deliberate reversal, and it should be recorded as one rather than
slipped in.

**The argument for reversing it:** the constraint's own stated purpose is that a ranked-guess gate
must not weaken verification without a backstop. This proposal *installs* the backstop — that is
the whole content of gap A — and #956's sibling tier `scoped-base-watch` is documented as waiting
for exactly such a "base-health backstop" before it can mean anything stronger than `scoped`.

**The honest caveat:** on day one the miss rate is still unmeasured. The sequencing below does not
pretend otherwise.

## Sequencing

Deliberately ordered so the safety mechanism exists before anything is weakened:

1. **Wire the sweep into the ledger (gap A).** DONE — `recordBaseSweepOutcome`, called from
   `verifyBaseBranchHealth`. Weakens nothing; only ever adds observations.
2. **Make cadence posture-driven and opt-in (gap B).** DONE.
3. **Add `impact` to the posture union and the `iterate` posture (gap C).** DONE.
4. **Flip this board to `iterate`.** DONE — `risk_posture_<board>` = `iterate`, and the stale
   explicit `verify_gate_strategy_<board>` = `scoped` override was cleared, since an explicit
   tier WINS over the posture and would otherwise have made the flip a no-op.
5. **Report the measured miss rate** and revisit — if it is bad, `iterate` is a bad setting for
   this board and step 4 gets reverted with data rather than opinion. **Still outstanding, and
   deliberately so:** on day one the rate is unmeasured, which is the honest caveat above.

Steps 1 and 2 stand on their own: they make even a `standard` project cheaper and better
instrumented.

## What the sweep can and cannot record

`recordBaseSweepOutcome` refuses a RED sweep whose failed suites cannot each be named
repo-relatively. The sweep parses a combined multi-package log with no per-package attribution,
unlike the gate, which has `FailedSuiteLike.packageLabel`. Dropping the unplaceable names would
understate the failed set — and an understated failed set understates the MISS COUNT, biasing the
corpus in the one direction that flatters the selection. A green sweep is unaffected: an empty
failed set is then the truth rather than a truncation.

So the corpus will fill from green sweeps and from reds whose output is fully attributable. If
that turns out to be too few rows to measure anything, the fix is per-package attribution in
`failed-suite-parse.ts`, not a looser rule here.

## What this does not propose

- **Removing the full gate.** `strict` keeps it, and it stays the right choice for a repo with a
  deployment.
- **Making untracked-guess selection the only check anywhere.** The `@gate:always-run` guard
  suites still run in every tier by construction — that is what the marker mechanism is for.
- **Changing what `pnpm test:mine` does in the inner loop.** That is the developer's own tool and
  is orthogonal.
