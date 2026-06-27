# Coverage dimensions — the orthogonal models

Line coverage is one weak axis. We track many orthogonal axes; a behaviour is "covered" only
when the dimensions that matter *for that behaviour* are each asserted. Each generated test
declares which dimensions it contributes (the author skill enforces this), so the matrix is
additive and re-runnable.

For each dimension: what it measures, and what **"covered" means** for a behaviour on that axis.

| Dimension | Measures | "Covered" = a test asserts … |
|-----------|----------|------------------------------|
| **capability** | the headline business capability works end-to-end | the capability's core happy-path outcome |
| **requirement** | a stated PRD/ADR/acceptance-criterion requirement is realised | the requirement's acceptance condition, traced to its id |
| **workflow** | a complete multi-step user journey | the whole journey's end-state, not isolated clicks |
| **user-journey** | realistic cross-capability paths (e.g. create→assign→work→merge) | the journey completes and the cross-capability invariant holds |
| **permission/role** | who may / may not do a behaviour | both an allowed actor succeeding AND a denied actor being refused |
| **navigation** | every reachable route/view loads and links work | the route renders its expected content; deep-links resolve |
| **feature** | a discrete feature toggle/control behaves | the feature's on and off states |
| **api** | endpoint contract (status, shape, side effect) | the response status + body shape + observable side effect |
| **error-handling** | observable failure modes | the specific error (4xx/validation/conflict/timeout) and its message/recovery |
| **boundary** | empty / max / off-by-one / unicode / huge inputs | behaviour at the edge value, not just a nominal one |
| **state-transition** | each edge of the state machine | the transition fires and lands in the expected post-state; illegal transitions are refused |
| **config** | behaviour under different settings/prefs/flags | the behaviour under ≥2 materially different configs |
| **cross-browser** | rendering/interaction across engines | the flow on each targeted engine (only if the product targets several) |
| **accessibility** | keyboard/ARIA/contrast reachability | the behaviour is operable by keyboard + has the expected a11y semantics |
| **regression** | a historically-broken behaviour stays fixed | the exact past failure cannot recur (ties a test to a bug id) |
| **risk** | high-blast-radius behaviour is guarded | the behaviour whose failure has the widest blast radius is asserted |
| **concurrency** | observable races (double-submit, parallel edits) | the system's response to the concurrent action is deterministic & correct |

## How to use the catalog
1. A behaviour declares (in `_behavior-model.json`) the `dimensions` it *belongs to*. Not every
   behaviour has every dimension — a read-only nav link has `navigation`, not `state-transition`.
2. Coverage is per (behaviour × dimension) cell. `dimensions_missing` on a behaviour = the dims
   it has but no test asserts. These are the gap atoms Phase 4 prioritizes.
3. The **matrix render** (`_coverage-matrix.md`) is capability rows × dimension columns; each
   cell shows covered/partial/uncovered counts so you can see at a glance that, e.g., `error`
   and `permission` columns are systematically empty (the usual finding).
4. Don't pad the matrix. A dimension that doesn't apply to a capability is blank, not "uncovered".
   `cross-browser` for a CLI tool, `permission` for a single-user local app — mark **N/A** with a
   one-line reason rather than manufacturing a gap. Honest N/A beats a fake red cell.

## Dimension selection per system (degrade sensibly)
- Single-user/local app (like agentic-kanban): `permission`/`role` is near-trivial — record it
  N/A-ish (one actor) rather than inventing RBAC tests. Weight `error`, `state-transition`,
  `workflow`, `concurrency`, `regression`, `config` instead.
- API-first/headless: drop `accessibility`/`cross-browser`; weight `api`, `boundary`, `error`, `contract`.
- Rich multi-role product: `permission` becomes a primary axis with allow+deny per role.
The point is a *true* picture of functional coverage, not a maximal grid.
