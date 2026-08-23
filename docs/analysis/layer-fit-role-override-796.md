# Layer fit: the client's 0.000 centre of gravity was a naming artifact (#796)

**Ticket:** #796 — follow-up to #742. **Measured at:** `05b9e685e8` (2026-08-23), after
#795 changed the module cut.
**Change:** a `[roles]` block in `.codemetricsrc` mapping `packages/client/src/lib/**`
to the `domain` role, plus one Option-A extraction out of `components/` into `lib/`.

## The finding #742 was filed against was not movable by refactoring

The code-metrics layer-fit signal infers each file's architectural role from path
convention (`_ROLE_RULES`, `runners/layerfit_runner.py`), ordered
`view → frontend → controller → service → domain → model`. The `frontend` rule matches
`(?:^|/)client/`, so it fires on `packages/client/…` **before** any inner-layer rule is
tried:

```
infer_role("packages/client/src/domain/foo.ts")  ->  "frontend"
```

Every one of the client's 633 files therefore scored `frontend` = axis position 0.0, and
the module's centre of gravity was pinned at exactly **0.000 by the package's name**.
#742's stated target — "client centre of gravity moving off 0.000" — was unattainable by
any code change, including the `client/src/domain/` directory it proposed. This is the
fourth time the number has been read as a structural absence; the config block is what
stops a fifth.

## `[roles]` overrides are genuinely supported, and are consulted first

Verified in source, not assumed:

- `config.py:346-350` parses a `[roles]` table into `Config.role_patterns`
  (`{role_name: [globs]}`), reserving the key `axis` for a custom axis.
- `pipeline.py:575` passes `role_patterns=cfg.role_patterns` into `run_layerfit`.
- `layerfit_runner.py:259-271` — `infer_role()` fnmatches the config patterns against the
  whole repo-relative path **before** falling through to `_ROLE_RULES`. Config wins.

The axis is `["frontend", "view", "controller", "service", "model", "domain"]`, so
`domain` is position 1.0; `DOMAIN_ROLES = {service, model, domain}` is the denominator of
`logic_in_adapter_ratio`.

## Why `lib/` is the honest label

`packages/client/src/lib/` is this client's domain layer by an explicit repo decision
(#589), enforced by `client-module-placement.test.ts`. Its branching mass is pure modules,
not transport — the top of the directory by decision points is `terminal-transcript.ts`
(118), `diff-highlight.tsx` (100), `appRoutes.ts` (84), `flightRecorderEvents.ts` (64),
`butler-event-reducer.ts` (61). `api.ts`, the one HTTP-shaped file, does not reach the top
20. So the override does not launder an adapter into the domain bucket.

## Measured effect

Both columns produced by running the analyzer's own `run_layerfit` + `summarize_layerfit`
over the identical 2,778-file set at `05b9e685e8`, with and without the block — the only
input the change touches.

| Signal | Before | After |
|---|---|---|
| **client centre of gravity** | **0.0000** | **0.2041** |
| overall centre of gravity | 0.3481 | 0.4342 |
| `logic_in_adapter_ratio` | 0.4628 | 0.3766 |
| adapter logic mass | 14,135 | 11,504 |
| domain logic mass | 16,410 | 19,041 |
| client `by_role` decisions | `frontend 12,892` | `frontend 10,261`, `domain 2,631` |
| layer leaks | 1 | 1 |
| server / shared CoG | 0.6011 / 0.8000 | 0.6011 / 0.8000 (unchanged) |

The leak count is unchanged, which is the check that matters: re-labelling `lib/` as
domain did not manufacture new violations. The single remaining leak is a
`query_in_adapter` on `ref.current?.select()` in `ButlerChrome.tsx` — a DOM
text-selection call, a tool false positive.

**What this buys:** the client CoG is now a number a refactor can move. Extracting a
testable rule from `components/` into `lib/` raises it; before the block, nothing could.

## What survives from #742, and is still open

By decision-point mass over non-test files, 69% of the client's branching sits in
`components/` at a 1:5.8 test-file ratio, against 1:1.5 in `lib/`. That is a testability
imbalance, not a missing layer. #762 separately ranks the client the *second best* module
on rework, so it is not currently producing defects at a rate that justifies a campaign —
the shape to use is opportunistic, one extraction at a time.

One such extraction landed with this ticket: `arePropsEqualIgnoring`
(`packages/client/src/lib/propsEqualIgnoring.ts`, 10 tests), lifted out of
`IssueCard.tsx` — the #5 highest-churn component. The rule carried a written safety
argument ("retaining a stale handler is sound *because* handlers are ignored and every
other prop is compared") that nothing verified. The handler-key set stays in the component
typed `keyof IssueCardProps`, so a renamed prop is still a compile error.

## The confirming full run agrees

`code-metrics analyze . --changeset-strategy pr` was then run end-to-end at the same commit
with the committed config. Its `layer_fit` block reproduces the table above over the
pipeline's own 2,835-file set:

```
centre_of_gravity      0.4345          (probe: 0.4342)
logic_in_adapter_ratio 0.3763          (probe: 0.3766)
adapter / domain mass  11,502 / 19,068 (probe: 11,504 / 19,041)
by_module CoG          client 0.2041, server 0.6012, shared 0.8000
client by_role         frontend 10,259, domain 2,631
leaks                  {query_in_adapter: 1}
```

The client CoG is identical to four decimal places; the sub-0.001 differences elsewhere are
the slightly wider file set the pipeline scans. The config change is therefore measured, not
merely reasoned about.

**One caveat on that run, unrelated to this change:** its `lizard` stage failed
(`no output (exit 1)`) under memory pressure on this box, which the analyzer reports loudly
and which zeroes every complexity-derived metric — `max_cyclomatic` is 0 for all 2,835 files
in that output, and `maintainability_index`/Halstead with it. Layer fit is unaffected:
`decision_points` are counted by the layer-fit runner itself, independently of lizard
(`SettingsPanel.tsx` still reports 76). `lizard` runs fine standalone on the same files, so
this is machine load, not a config or tool defect — but do not pin a complexity baseline to
`code-metrics-out/analysis.json` as it stands.
