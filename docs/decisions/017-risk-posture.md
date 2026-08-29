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
- `redBasePolicy` and `builderStopChecks` still have no consumer — the red-debt ledger
  (#915/#916) and the builder Stop-hook policy plumbing (#913/#914) are separate,
  not-yet-landed tickets; the struct emits both fields now so those tickets consume them
  rather than inventing their own vocabulary.

Builds on decision 008 (Start Mode consolidation) and decision 006 (board-monitor orchestrator,
for the `objective.md` render path #912 adds). Proposal:
`docs/proposals/2026-08-25-risk-posture-and-merge-train.md`.
