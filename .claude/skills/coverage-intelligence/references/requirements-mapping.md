# Requirements mapping — requirements ⇄ behaviours ⇄ tests

Phase 1 maps tests→behaviours (what's verified). This phase maps **requirements→behaviours**
(what *should* be true), independently — that independence is what surfaces the two hardest
gap classes: behaviour with no requirement, and requirement with no behaviour.

## Mine requirements from sources independent of the behaviour model
Fan out one agent per source; each extracts atomic, testable requirements with a stable id and
its source anchor:

| Source | Where (this repo) | Requirement flavour |
|--------|-------------------|---------------------|
| PRD / spec | `docs/prd/00,03,04,05,06` | product capabilities, MVP scope, data-model rules |
| Acceptance criteria / features | `docs/prd/01-features-catalog.md` (F-XXX entries) | per-feature accept conditions + DONE/SKIP status |
| Decision records | `docs/decisions/` (003 Butler, 006 monitor, 008 Start Mode…) | binding architectural/behavioural constraints |
| Constraint / error catalog | `CLAUDE.md` "Hard Constraints", typed-error classes, route error mapping | invariants the system must never violate |
| Test suite | unit/integration tests | executable requirement specs — the richest edge-case source |

Give each requirement an id like `PRD-04:auto-launch`, `ADR-008:start-mode-manual-killswitch`,
`CONSTRAINT:never-delete-db`, `F-023:graph-view`.

## Classify each requirement (assume unverified until proven)
For each requirement, search the behaviour model + `_coverage.json` for a behaviour that
realises it and a test that asserts it. Default assumption: **unverified**. Then:
- **covered** — a behaviour realises it AND a test asserts that behaviour's outcome.
- **partial** — a behaviour realises it but coverage is partial, or it spans behaviours only
  some of which are tested.
- **uncovered** — a behaviour realises it but no test asserts it.
- **documented-missing** — **no behaviour realises it.** The code may not implement the
  requirement. ⇒ **VERIFY in code before asserting** (you may have missed the behaviour). If
  genuinely absent: this is a likely bug or a dead requirement — escalate, don't silently file.

## Reverse direction — find undocumented-implemented behaviour
For each behaviour in the model with **no** matching requirement from any source, mark it
`undocumented-implemented`. This is real behaviour nobody specified — surface it: it may be a
needed test for an intentional feature, or a sign of scope the product owner should decide on.

## Reconcile into the five-way status
Every behaviour and every requirement ends in exactly one of:
`covered · partial · uncovered · undocumented-implemented · documented-missing`.
Write the requirement-side index into `_coverage.json.requirements[]` and fold the behaviour-
side results into `behaviors[]`. The `documented-missing` and `undocumented-implemented` rows
are the headline findings of the whole skill — they are *gaps the test suite alone can never
reveal* — put them at the top of `_gaps.md`.

## Output
- `_coverage.json.requirements[]`: `{ id, source, status, behaviors[], tests[] }`.
- A gap-report section listing every MISSING/PARTIAL/documented-missing/undocumented-implemented
  requirement, each with disposition: **fix-now** (write the test), **verify-impl** (chase the
  documented-missing), **decide-scope** (undocumented behaviour → product decision), or
  **N/A-with-reason**.

The highest-yield source is the **test suite** (existing tests encode edge-case requirements
the PRD never states) and the **constraint catalog** (invariants like "never delete the DB",
"409 on busy turn") — sample those hardest.
