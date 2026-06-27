# Prioritization — pricing every gap by ROI

Every gap gets a priority and a rationale. Generate-highest-value-first falls out of this order.
The author skill builds the backlog top-down and stops when ROI drops below the bar the user set.

## The four factors (score each 1–5)
- **business_impact** — how much a failure of this behaviour hurts the user/business. Seed from
  the capability's role (core flow vs peripheral) and the behaviour's `risk` (blast radius).
- **regression_value** — how likely this behaviour is to break again. Seed from
  `historical-signals.md`: churn (frequently-changed code) + bug history (past failures here).
  A behaviour that broke before and changes often scores 5.
- **exec_cost** — cost to RUN the test repeatedly: wall-clock, flakiness risk, infra needs
  (spawns an agent? needs the network? slow setup?). Lower is better — invert when combining.
- **maint_cost** — cost to KEEP the test: coupling to volatile UI, fixture complexity,
  likelihood of churn-induced breakage. Lower is better — invert when combining.

## ROI
```
ROI = (business_impact × regression_value) / (exec_cost + maint_cost)
```
Compute it, then sanity-check against the P-band rubric — ROI ranks *within* a band; the band
is set by intent, not arithmetic alone.

## P-bands (with required rationale)
| P | Meaning | Typical members |
|---|---------|-----------------|
| **P0** | critical business workflow, unverified | the capability's core happy path with no asserting test; a "never violate" constraint (e.g. DB-deletion guard) untested |
| **P1** | frequently-used workflow, gap | common journeys; high-churn behaviours; primary error states (409-on-busy, validation) |
| **P2** | secondary workflow | less-common but real flows; config variants |
| **P3** | edge cases | boundary/empty/huge-input; unusual but reachable states |
| **P4** | negative scenarios | permission-denied, invalid-input rejection, illegal state transitions |
| **P5** | regression locks | pin a specific past bug so it can't recur (ties to a bug id) |

A behaviour can warrant tests at several P-levels (P0 happy path + P4 its rejection path) — emit
one backlog row per (behaviour × missing-dimension) gap, not one per behaviour.

## Output — `_priorities.md` rows are self-contained gap specs
Each row carries everything `e2e-test-author` needs so it never re-derives context:

```md
### [P1 · ROI 6.3] workspaces.create.busy — assert 409 on follow-up turn to a busy workspace
- capability: workspaces · dimensions to add: error, api
- actor: operator · preconditions: a running workspace (session in-flight)
- entry point: POST /api/workspaces/:id/turn  (UI: chat input while agent running)
- observable outcome: request returns 409; UI shows "agent busy", no second turn enqueued
- suggested assertions: status 409; response body error code; session count unchanged
- factors: impact 4 · regression 4 (turn endpoint churns) · exec 2 · maint 2 → ROI (4×4)/(2+2)=4.0
- evidence: packages/server/src/routes/workspace-actions.ts:NN ; behaviour ws.create.busy (confidence high)
- existing partial: ui/workspace-turn.test.ts touches turn but never asserts the busy path
```

## Scaling to the user's ask
- "find the highest-value tests" / quick pass → emit P0–P1 only, cap the list (say 10).
- "be comprehensive" / full audit → emit through P5, but still ranked, so the author works
  top-down and the user can cut the tail.
- Always **log the cut line**: if you stop at P2, say so in `_priorities.md` — silent truncation
  reads as "nothing below this matters", which is false.
