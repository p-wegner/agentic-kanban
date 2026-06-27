---
name: coverage-intelligence
description: Build a multidimensional functional-coverage model for a software system and rank the highest-ROI verification gaps. Binds the observable-behaviour model (from behavior-discovery) against requirements (PRD/ADRs/user stories/acceptance criteria), the existing test suites (unit/integration/e2e), and historical signals (git churn, bug history) to compute — per behaviour — whether it is covered / partial / uncovered / undocumented-implemented / documented-missing, across many orthogonal coverage dimensions (capability, requirement, workflow, permission, navigation, API, error, boundary, state-transition, config, accessibility, regression, risk). Produces a coverage matrix, gap report, and an ROI-ranked test backlog. NOT line coverage. Use when the user asks "what's our real test coverage", "what behaviour is unverified", "where are the coverage gaps", "what tests give the most value", "map requirements to tests", "build a coverage model", or as phase 2 of an end-to-end verification effort.
---

# coverage-intelligence

The **binding layer** of the verification pipeline. Discovery says *what the app does*; this
skill answers *how well is each of those behaviours actually verified, along every dimension
that matters, and what should we test next for the most value?*

This is deliberately **not line/branch coverage**. A file at 100% line coverage can have zero
of its error states, permission boundaries, or state transitions asserted. We measure
**functional coverage** of observable behaviours across many orthogonal dimensions, and we
price every gap by return on investment.

It is **deterministic-then-semantic**, like its sibling skills: a script inventories the
existing tests mechanically; subagents do the meaning-level mapping of tests→behaviours and
requirements→behaviours; the orchestrator scores and ranks.

Reads the shared model (**`references/verification-model.md`** — the canonical schema, owned
here). Consumes `docs/verification/_behavior-model.json` (from `behavior-discovery`). Writes
`_coverage.json`, `_coverage-matrix.md`, `_gaps.md`, `_priorities.md`. Re-running **updates**
the model incrementally.

---

## Prerequisite
`docs/verification/_behavior-model.json` must exist. If it doesn't, run **`behavior-discovery`**
first (or, for a quick pass, point this skill at `docs/domain/_plan.json` + route files and it
will build a thin behaviour list inline — but the real model is far better).

---

## Phase 0 — Deterministic test inventory
Run the bundled scanner to get a ground-truth map of what tests exist and what they touch —
*before* any subagent reasons about coverage, so the reasoning is anchored, not hallucinated.

```
node <skill>/tools/test-inventory.mjs <repo> > docs/verification/_test-index.json
```

It scans the test dirs (Playwright `packages/e2e`, vitest unit/integration, etc. — stack-aware),
and per test file extracts: `describe`/`test` titles, API paths hit (`/api/...`), routes
visited (`page.goto`), MCP tools invoked, and assertion count. This is the **candidate set**
each behaviour's tests are matched against — it turns "does a test cover this?" from a guess
into a lookup. Also pulls historical signal: `git log` churn per source file + (if available)
bug-labelled issues per area.

---

## Phase 1 — Map existing tests → behaviours (semantic)
For each capability, dispatch a **`general-purpose`** subagent briefed by
`references/mapping-brief.md`, given the capability's behaviours + the **candidate test set**.
Build that candidate set as the **union** of `_test-index.json` entries that (a) hit the
capability's API routes (`api_paths`), (b) visit its UI routes, OR (c) **import its source files**
(`imports`/`import_basenames` matching the capability's `source_paths` basenames). Matching by
*source* (c) is essential: unit tests like `merge-cascade.test.ts` cover a `workspaces` behaviour
without ever carrying the word "workspace", and a slug-keyword filter silently misses them —
which makes genuine coverage look like a gap. Never scope candidates by slug keyword alone. The subagent decides, per behaviour, which existing tests
exercise it and **whether they assert the outcome or merely touch the path** (`asserts-outcome`
vs `touches-only`) — the line between *covered* and *partial*. It also records, per behaviour,
which **dimensions** the existing tests actually assert vs which the behaviour has but nothing
asserts (`dimensions_missing`). Output merges into `_coverage.json`.

## Phase 2 — Map requirements → behaviours → tests (the gap taxonomy)
Independently of the tests, mine requirements and bind them to behaviours — this is what
surfaces *documented-missing* and *undocumented-implemented* gaps. Per `references/requirements-mapping.md`,
fan out one agent each over: PRD/spec (`docs/prd/`), decision records (`docs/decisions/`),
acceptance criteria/user stories, and the constraint/error catalog (CLAUDE.md hard rules,
typed-error classes). Each extracts requirements and, **assuming each is unverified until it
finds a covering behaviour+test**, classifies it. Reconcile both directions into the five-way
status on every behaviour and requirement:

- **covered** · **partial** · **uncovered** · **undocumented-implemented** · **documented-missing**

(`undocumented-implemented` = behaviour in code/UI, no requirement — review whether it should
exist. `documented-missing` = requirement with no implementing behaviour — **verify against
code before asserting**, then escalate as a likely bug or dead requirement.)

## Phase 3 — Score dimensions + compute the matrix
Fill `_coverage.json.summary`: per-dimension and per-capability roll-ups. Render
`_coverage-matrix.md` (capability × dimension grid, each cell covered/partial/uncovered with
counts) and `_gaps.md` (the five buckets, each gap with its rationale and missing dimensions).
The dimension catalog and what "covered" means for each is in `references/coverage-dimensions.md`.

## Phase 4 — Prioritize by ROI (the test author's work-list)
Score every gap by `references/prioritization.md`: **ROI ≈ (business_impact × regression_value)
/ (exec_cost + maint_cost)**, with regression_value seeded from `references/historical-signals.md`
(churn + bug history — bug-prone, frequently-changing behaviours get a regression premium).
Assign P0–P5 with explicit rationale. Write `_priorities.md` as a ranked backlog where **each
row is a self-contained gap spec** (capability, behaviour, actor, preconditions, observable
outcome, entry point, suggested assertions, dimensions to add) — so `e2e-test-author` can build
from a row without re-deriving context. Generate-highest-value-first is enforced by this order.

## Phase 5 — Audit the existing tests (deletions, not just additions)
Coverage isn't only gaps. Per `references/mapping-brief.md` (audit section), flag existing
tests that are **duplicates**, **low-value** (assert nothing observable), **implementation-
coupled** (assert internals/brittle selectors), **flaky** (known-flaky list / history), or
**obsolete** (cover removed behaviour). Recommend deletions/merges in `_gaps.md` — a leaner,
truer suite is a coverage *improvement*.

---

## Re-running improves the model
On a re-run: refresh `_test-index.json`, re-map only capabilities whose `analyzed_sha` or test
files changed, and **fold in tests the author skill added** (their `_authored.json` entries flip
behaviours to covered). Append each run to `_verification-log.md`. The coverage score should
monotonically improve across the discover→cover→author loop; if it doesn't, the loop found new
behaviour faster than it covered it — that's signal, log it.

## Rules
- **Functional coverage, never line coverage.** A behaviour is covered only when a test asserts
  its *observable outcome* across its risk-relevant dimensions — not when a line ran.
- **Assume uncovered until proven.** A behaviour is uncovered until a specific test is shown to
  assert it. No optimistic defaults.
- **Every gap is priced.** No gap ships without business_impact, regression_value, costs, and a
  P-level rationale. Unranked gaps are noise.
- **Anchor on the deterministic inventory.** Tests claimed to cover a behaviour must exist in
  `_test-index.json`. Don't credit coverage to a test you can't point at.
- **`documented-missing` is verified before it's asserted.** Read the code; a requirement may be
  met by a behaviour you mislabelled. Only escalate genuine absences.
- **Deletions count.** Recommending removal of a duplicate/flaky/coupled test improves coverage truth.

## Reference files
| File | Use |
|------|-----|
| `references/verification-model.md` | the canonical shared schema (owned here) |
| `references/coverage-dimensions.md` | the orthogonal dimension catalog + "covered" definition per dimension |
| `references/mapping-brief.md` | Phase 1/5 — test→behaviour mapping + existing-test audit subagent prompt |
| `references/requirements-mapping.md` | Phase 2 — requirement→behaviour mining + five-way classification |
| `references/prioritization.md` | Phase 4 — the ROI model + P0–P5 rubric |
| `references/historical-signals.md` | Phase 4 — churn + bug-history → regression premium |
| `tools/test-inventory.mjs` | Phase 0 — deterministic existing-test scanner |
