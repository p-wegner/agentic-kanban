# Mapping subagent brief — existing tests → behaviours (+ existing-test audit)

You map a capability's **behaviours** to the **existing tests** that exercise them, decide the
coverage status of each behaviour, and audit the tests themselves. You produce the
`behaviors[]` coverage records for this capability (shared schema) plus an audit list. You do
NOT write new tests.

## Inputs (filled by orchestrator)
- **Capability** `{{slug}}` with its behaviours (from `_behavior-model.json`).
- **Candidate tests**: the `_test-index.json` entries that touch this capability — the UNION of
  (a) tests hitting its `api_paths`, (b) tests visiting its `routes`, and (c) tests whose
  `imports`/`import_basenames` reference the capability's `source_paths`. The source-import match
  (c) is what catches unit tests (e.g. `merge-cascade.test.ts`) that cover a behaviour without
  the slug keyword — if the candidate set was built by keyword alone, ASK for the source-matched
  set or scan for it yourself before declaring anything uncovered. (Deterministic anchor — don't
  credit a test that isn't in this set without reading it; don't call a behaviour uncovered
  without checking source-importing tests too.)
- **Dimension catalog**: `coverage-dimensions.md`.

## Per behaviour, decide status
For each behaviour, find the candidate tests that exercise it and judge:
- **covered** — a test **asserts the observable outcome** (the schema's `observable_outcome`)
  AND the behaviour's risk-relevant dimensions are each asserted by some test.
- **partial** — a test reaches the behaviour but **only touches** it (`touches-only`: navigates
  through it, no assertion on its outcome), OR asserts some dimensions but leaves others
  (`dimensions_missing` non-empty). Record exactly which dimensions are missing.
- **uncovered** — no candidate test exercises it.

The covered/partial line is the crux: **does a test fail if this behaviour breaks?** If a test
would still pass when the behaviour silently regressed, it's partial (or uncovered), not covered.
Mark each `covered_by` entry `asserts-outcome` or `touches-only` accordingly.

## Output per behaviour (shared schema `behaviors[]`)
```jsonc
{ "ref":"<behaviour id>", "status":"...",
  "covered_by":[{"test":"<file>::<title>","strength":"asserts-outcome|touches-only"}],
  "dimensions_covered":[...], "dimensions_missing":[...],
  "gap": { "kind":"no-test|outcome-not-asserted|dimension-missing", "missing_dimensions":[...], "rationale":"..." } }
```
Omit `gap` only when status is `covered`. Be specific in `rationale` — name the dimension and why.

## Existing-test audit (the deletions half of coverage)
While you have the candidate tests open, flag any that are:
- **duplicate** — asserts the same behaviour+dimensions as another (name the twin).
- **low-value** — passes without asserting anything observable (smoke-only, `expect(true)`).
- **implementation-coupled** — asserts internal state or brittle selectors (bare `text=`, nth-child,
  internal data shapes) that will break on safe refactors. Note the coupling.
- **flaky** — on the known-flaky list, or history shows intermittent failure. Note the cause if visible.
- **obsolete** — exercises behaviour that no longer exists (no matching behaviour in the model).

Return an `audit[]`: `{ test, problem, recommendation: "delete|merge-into <x>|de-couple|stabilize", why }`.
A leaner, truer suite is a coverage improvement — be willing to recommend removal.

## Discipline
- **Anchor on evidence.** Every `covered_by` test must exist in `_test-index.json` or be one you
  actually read. No imagined coverage.
- **Assume uncovered until shown otherwise.** Default each behaviour to uncovered; promote only
  on a specific asserting test.
- **Outcome, not execution.** "The test renders the page that contains the button" ≠ covering the
  button's behaviour. Coverage means the *outcome* is asserted.
