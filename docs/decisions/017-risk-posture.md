# Decision 017: One risk-posture dial, fanned out to every consumer that trades speed for rigor

## Date: 2026-08-28

## Context
An operator wanting a project to move faster had to align **~8 independent prefs by hand**, with
no single source of truth — the same class of drift decision 008 fixed for start modes:

| Pref | What it controls |
|---|---|
| `verify_gate_strategy_<id>` | Pre-merge gate tier (`full` / `scoped` / `scoped-base-watch`) |
| `auto_review` / `review_auto_fix` | Whether/how a review agent runs before merge |
| `quiesce_builders_during_gate_<id>` | Whether new builder starts are held while a gate runs |
| `file_contention_<id>` | Auto-start deferral on shared-file contention (`off`/`warn`/`serialize`) |
| `verify_max_workers_<id>` | Gate's vitest worker cap |
| Strategy Bullseye WIP | How many tickets run concurrently |
| Merge strategy (`train_max_size_<id>` etc.) | Sequential vs. batched merge |

Getting a project genuinely fast (or genuinely strict) meant writing several of these
consistently — and nothing said what a partial write silently left at its old (safer or looser)
setting. Nothing named the trade-off either: a project running "scoped" gate + train batching
looked identical in the UI to one running the safe default, unless an operator opened Settings
and checked each pref by hand.

## Decision
Introduce a **single per-project risk posture** — `risk_posture_<projectId>` ∈ `strict |
standard | fast | sprint` — resolved by `resolveRiskPosture(prefMap, projectId, opts?)`
(`packages/server/src/services/risk-posture.service.ts`), mirroring `resolveStartPolicy`
(decision 008): a pure, synchronous prefMap resolver that is the ONE place every consumer reads
instead of the raw prefs above.

```ts
interface RiskPosture {
  level: "strict" | "standard" | "fast" | "sprint";
  source: "risk_posture" | "issue_tag" | "default";
  gateTier: "full" | "scoped" | "scoped-base-watch";
  reviewMode: "thorough" | "standard" | "train-only" | "none";
  redBasePolicy: "block" | "allow-known-debt" | "allow-file-debt-ticket";
  trainMaxSize: number;
  trainMaxWaitMs: number;
  builderStopChecks: "tests-and-typecheck" | "tests-capacity-gated" | "typecheck-only" | "none";
  contentionMode: "off" | "warn" | "serialize";
  placementBias: "host-half" | "host-preferred" | "remote-preferred";
  summary: string; // names what this posture skips, relative to `standard`
}
```

- **`standard` reproduces today's behaviour exactly** — `gateTier: "full"` (matching
  `DEFAULT_VERIFY_GATE_STRATEGY`), `trainMaxSize: 1` (matching the sequential-path default in
  `merge-queue.service.ts`, NOT the proposal's target "≤4" — that number is #905's to raise),
  `contentionMode: "serialize"` (matching `resolveFileContentionMode`'s default). This is a
  deliberate divergence from the original proposal's table, which described the *target* state
  after related tickets land, not the *current* one this resolver must reproduce.
- **`strict` / `fast` / `sprint`** trade rigor for speed as documented in the proposal
  (`docs/proposals/2026-08-25-risk-posture-and-merge-train.md` §3): `fast` reviews the merge
  train instead of each ticket and allows a known-red base; `sprint` skips per-ticket review
  entirely, runs a guards-only gate, and turns builder self-tests off.
- **Per-ticket override**: an issue tag `risk:strict|standard|fast|sprint` wins for that
  ticket's workspace over the project's pref (`getIssueRiskTag` / `resolveIssueRiskPosture`,
  prefix-scanned so the tag NAME carries the level, mirroring `hasSkipAutoStartTag`'s shape).
- **Visibility rule**: every `RiskPosture` carries a `summary` naming what it skips relative to
  `standard`. A weaker posture may only weaken verification *visibly* — the same rule the gate
  tier (#538) already enforces for itself; posture reuses rather than replaces it.
- **Enforcement**: `risk-posture-raw-read-ratchet.test.ts` scans server/mcp-server/client/shared
  source for the literal `risk_posture_` substring outside the resolver and its own pref-key
  registration, zero-tolerance (mirrors `auto-review-pref.test.ts`'s shape for `auto_review`).

## Consequences
- One dial in Settings → Workflow (#912) instead of ~8 scattered prefs; the same dial renders
  into `objective.md` for the Conductor and is exposed via `resolveMonitorTunables` for the
  deterministic engine.
- **This ticket (#911) wires the resolver plus the one consumer that was already prefMap-shaped
  and safe to convert without touching the DB-reading gate service's call graph**:
  `resolveProjectContentionMode` (`startup/monitor-file-contention.ts`) now falls back to
  `resolveRiskPosture(...).contentionMode` when no explicit `file_contention_<id>` override is
  set, preserving the explicit pref as a finer-grained escape hatch.
- **#937 wired the remaining four**, each as the same pair: a pure `resolveX(prefMap, projectId)`
  resolver (matching the `prefMap-resolver` kind) plus, where the call sites needed one, a thin
  `async (projectId, database)` wrapper that builds a prefMap and reads through it — exactly the
  shape `resolveIssueRiskPosture` already used.

  | Field | Resolver | Explicit override that still wins |
  |---|---|---|
  | `gateTier` | `resolveGateTier` (`pre-merge-gate-tier.ts`), wrapped by `resolveVerifyGateStrategy`/`resolveGateTierFor` | `verify_gate_strategy_<id>` |
  | `reviewMode` | `resolveProjectReviewMode` (`services/review-mode-pref.ts`) → `{run, mode, thorough}` | `review_mode_<id>` (for `mode` only) |
  | `trainMaxSize` / `trainMaxWaitMs` | `resolveTrainWindowConfig` + `resolveTrainOptInSize` (`merge-train-window.ts`), wrapped by `resolveProjectTrainMaxSize`/`resolveTrainOptIn` | `train_max_size_<id>` and `train_max_wait_ms_<id>`, independently of each other |
  | `placementBias` | `remoteDispatchBlockedByPlacementBias` (`risk-posture.service.ts`), a new `placement_bias` step in `resolveWorkerPlacement` + `PLACEMENT_CHECK_CHAIN` + docs §7 step 4 | — (the posture IS the dial) |

  Three consequences worth stating, because each is a place the obvious wiring would have been
  wrong:
  - **`reviewMode` is three decisions, not one.** `none` (sprint) skips the per-ticket review —
    but it may not override a workspace's own `requiresReview`, and the stranded-review
    reconciler had to learn it too, or `sprint` would strand every ticket at "waiting for a
    review that will never come" instead of marking it mergeable.
  - **`trainMaxSize` feeds two different consumers with two different defaults.** The merge
    QUEUE's `> 1` opt-in defaults to 1 (sequential, today's behaviour); the #905 batching
    WINDOW has always defaulted to 4/10 min. A posture may only make a project faster or
    stricter than its dial says, never silently retune a window nobody touched — so only a
    posture that ASKS for batching (`trainMaxSize > 1`, i.e. `fast`/`sprint`) overrides the
    window, and `standard`/`strict` keep the shipped defaults.
  - **`placementBias` blocks only for `host-half`.** `host-preferred`/`remote-preferred` are
    preferences, and the board has no worker-side attestation to bias toward a machine with
    (#651's open half), so reporting either as a refusal would be the "weakens invisibly"
    failure this decision forbids. `host-half` (strict) refuses for the same reason
    `allowed_profiles_<id>` does: a worker authenticates with its own local login and cannot be
    made to honour the posture (decision 012).
- **The visibility rule has one implementation**: `formatPostureNote` (`risk-posture.service.ts`)
  renders `.summary` + `.source`, and every message site that read a posture field calls it —
  the gate message (via `GateTierInfo.posture`), the review launch, the train-window release,
  the merge-queue train dispatch, the stranded-review recovery. It returns `""` for a missing
  posture, so "no note" can never be mistaken for "standard".
- `redBasePolicy` and `builderStopChecks` had no consumer when this decision landed — the red-debt ledger
  (#915/#916) and the builder Stop-hook policy plumbing (#913/#914) are separate,
  not-yet-landed tickets; the struct emits both fields now so those tickets consume them
  rather than inventing their own vocabulary. (`redBasePolicy` gained its consumer in #1015 —
  see the amendment below; `builderStopChecks` still has none.)

Builds on decision 008 (Start Mode consolidation) and decision 006 (board-monitor orchestrator,
for the `objective.md` render path #912 adds). Proposal:
`docs/proposals/2026-08-25-risk-posture-and-merge-train.md`.

---

## Amendment 2026-09-04 (#1015): `redBasePolicy` has a consumer, and is overridable — softer only

Two changes, both narrow. Nothing above is retracted.

### 1. The merge gate's red-debt subset rule keys on `redBasePolicy`, not on the level

`workspace-merge-gate.ts`'s #915 subset rule asked `posture.level === "fast" || "sprint"`. That
was equivalent to asking for `redBasePolicy !== "block"` — the levels are exactly the two whose
policy is soft — but only *accidentally* equivalent: it made `redBasePolicy` a field the struct
emitted and nothing read, which is what line 112 above admitted. It now reads the field, and
`merge-gate-red-debt-subset-rule.test.ts` pins the equivalence for every level, so a level whose
policy changes cannot silently keep (or lose) the softening.

The #916 debt cap moved with it. It used to degrade the LEVEL (`sprint` → `fast` → `standard`)
and rely on the degraded level falling out of the `fast || sprint` check; it now degrades the
POLICY (`allow-file-debt-ticket` → `allow-known-debt` → `block`,
`resolveEffectiveRedBasePolicy`). That is not cosmetic: with the override below, a project can
reach a soft policy from a level that has no degrade step, and a level-shaped cap would have let
it soften verdicts forever — the exact hole #916 exists to close.

### 2. `red_base_policy_<projectId>` — a per-project override, in the soft direction only

Registered in the dynamic preference-key registry and applied in `resolveRiskPosture` AFTER
level derivation (`applyRedBasePolicyOverride`). `block` → `allow-known-debt` →
`allow-file-debt-ticket` is honoured; **a stricter value is ignored with a logged warning**, as
is an unrecognized one (fail closed — the level's own policy stands).

Why softer-only rather than a free field. The level is the dial that says how strict a project
is; a per-field key that could TIGHTEN one dimension would re-create precisely the problem this
decision was written against — several prefs to align by hand, with nothing saying what a partial
write left behind. Loosening is different in kind. The dev board wants to *land, then heal* on a
red master (proposal `2026-09-03-dev-board-vs-deployed-board.md` §3.B) while keeping posture
`iterate`'s gate tier, review mode and train sizing; without this key the only way there is to
adopt `fast` or `sprint` wholesale, which changes five other things nobody asked to change.

The visibility rule (above) still binds, and applies twice here:

- An applied override is folded into `RiskPosture.summary`, so every message built with
  `formatPostureNote` names it.
- A gate the subset rule SOFTENS names the policy in its evidence — `pre-lock-merge (red-debt
  subset rule #915, redBasePolicy 'allow-file-debt-ticket': …)` — so a reader can tell a
  level-derived softening from a per-project override without opening the prefs. A `block`
  project cannot reach that path at all, so there is no case where the policy goes unnamed.

Enforcement mirrors `risk_posture_`'s: `red-base-policy-raw-read-ratchet.test.ts` is a
zero-tolerance scan for the literal `red_base_policy_` outside the resolver, its registration and
their tests. Without it a consumer could read the operator's requested value with no
direction check at all, which is the whole guarantee.

**What this ticket deliberately did NOT do**: it set the pref on no project (the dev board
included), and it did not build the nightly-sweep `heal` ticket §3.B pairs with it — that is
#1016. Landing on a red base without the heal ticket is a worse state than blocking, so the two
are meant to be switched on together.

## Amendment 2026-09-04 (#1031): `standard` sweeps half-daily, and the per-posture cadence is pinned

**Decision: `standard`'s full-suite base sweep moves from 30 min to 12 h** — the same cadence as
`strict`, for the same reason. The alternative (keep 30 min and correct the dev-board proposal's
§3.B claim) was rejected.

Why. When #983 added `sweepIntervalMs` to the posture, `standard` was given the pre-posture
constant `BASE_HEALTH_DEFAULT_INTERVAL_MS` (30 min) under this record's own "reproduces today's
behaviour exactly" rule. But that rule was written about the *gate* fields (`gateTier`,
`trainMaxSize`, `contentionMode`, the per-cycle caps) — the things a project's merge behaviour
depends on. The sweep is a background signal, not a gate, and the cadence table that resulted
was incoherent: a `full` per-merge gate already verifies every landing, so `strict`'s comment
argues that a sweep only adds value for changes that reach the base *outside* a merge and
half-daily is enough for that — and `standard` has the very same `full` gate. It was the only
posture left running the full suite 48x a day on the shared box (every other posture sweeps 2-4x),
and proposal `2026-09-03-dev-board-vs-deployed-board.md` §3.B's "sweep only per posture, nightly"
claim was false for exactly that one posture. Choosing 12 h rather than 24 h keeps `standard`
at least as watchful as `strict`; a `standard` project with a real deployment is expected to move
to `strict` anyway.

What "today's behaviour exactly" now means for `standard`: **every gate/merge field is unchanged;
the sweep cadence is the one deliberate exception**, called out in the posture table's comment.
`BASE_HEALTH_DEFAULT_INTERVAL_MS` remains only the sweep loop's tick rate.

The pinned table (decision-level; a change to any row amends this record):

| Posture | Per-merge gate | Full-suite sweep |
|---|---|---|
| `strict` | full | 12 h |
| `standard` | full | **12 h** (was 30 min) |
| `iterate` | impact | 24 h |
| `fast` | scoped | 6 h |
| `sprint` | scoped-base-watch | 24 h |
| *(no posture chosen)* | full | never — the opt-in rule (#983) |

Enforcement: `risk-posture.service.test.ts` pins every row (`PINNED_SWEEP_INTERVALS`) and
separately asserts that no posture sweeps more often than every 6 h, so the 30-minute constant
cannot be re-adopted by one posture quietly.

**Visibility.** The effective cadence is now on the wire, not only in this table.
`describeBaseSweep` (`risk-posture.service.ts`) reports `{ scheduled, intervalMs,
nominalIntervalMs, postureLevel, postureSource, reason, nextDueAt }` — built on
`resolveBaseSweepIntervalMs`, so it can never claim a sweep for a project the opt-in rule
excludes. `GET /api/projects/:id/base-branch-health` carries it as `sweep`;
`GET /api/projects/health` carries it per project as `baseSweep`, and the Project Health
Overview renders it (`base sweep every 12 h (standard)` / `base sweep off (no posture chosen)`),
so an operator can list which projects are on which cadence from one response.
