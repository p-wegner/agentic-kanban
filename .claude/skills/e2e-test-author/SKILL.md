---
name: e2e-test-author
description: Generate the highest-ROI end-to-end tests from a prioritized coverage-gap backlog, then subject them to an adversarial review that tries to REFUTE them before they land. Consumes the verification model (_priorities.md / _coverage.json from coverage-intelligence), authors complete user-workflow tests (not isolated clicks) using the target project's own anti-flake conventions, makes each test DECLARE the coverage dimensions it contributes, runs independent adversarial reviewer subagents (overfitted assertions, flaky interactions, false positives, missed edge cases), fixes what they find, and writes the new coverage back into the model so re-running the pipeline improves. Use when the user asks to "write the missing tests", "generate high-value e2e tests", "author tests for the coverage gaps", "close the top coverage gaps", or as phase 3 of an end-to-end verification effort. For a single ad-hoc test in agentic-kanban use the project `e2e-author` skill instead; this skill is the gap-driven, reviewed, batch author.
---

# e2e-test-author

Turn the ROI-ranked gap backlog into **tests worth keeping**. Two non-negotiables separate this
from "ask an LLM to write a test":
1. **Generate from gaps, highest-value first** — never blanket-generate. The backlog
   (`_priorities.md`) is the work order; you build top-down and stop at the user's ROI bar.
2. **Adversarial review before landing** — every generated test is attacked by independent
   reviewer subagents whose job is to *refute* it (it asserts nothing, it's overfitted, it's
   flaky, it tests the implementation not the behaviour). Only survivors land.

Then **close the loop**: write the new tests back into `_coverage.json` so the behaviour flips
to covered and a re-run of the whole pipeline measurably improves instead of re-discovering the
same gaps.

Reads the shared model (**`../coverage-intelligence/references/verification-model.md`**).

### This skill is the "generator" + "healer" (cf. Playwright Agents)
The planner (`coverage-intelligence`) produces the living `_testplan.md` and the ranked
`_priorities.md` work order. This skill is the **generator** — it implements the plan's open
scenarios top-down and checks them off (re-rendering the plan flips `[ ]`→`[x]`). It is also the
**healer**: when an authored or existing test fails or flakes, run it down to a real cause with
the `flaky-test-triage` skill (known-flaky vs regression), fix the test or escalate a real
product bug, and only then re-render. A green suite that matches the plan is the goal state.

---

## Phase 0 — Inherit the project's test conventions (don't reinvent them)
Tests must follow the **target project's own** harness and anti-flake rules, or they'll be
flaky and rejected. Resolve them in this order:
- **agentic-kanban**: use the project **`e2e-author`** skill's RULES 1–8 verbatim (127.0.0.1,
  no hardcoded ports, `getE2EProjectId` not `projects[0]`, scoped selectors, `Date.now()`
  suffixes, mandatory `afterAll` cleanup, retry-not-skip, no fixed sleeps). Tests live in
  `packages/e2e/tests/{ui,api}/`. **Do not run `playwright install`.**
- **a driven project**: use the stack scaffold the board placed (`deriveTestScaffold`/
  `writeTestScaffold` → the project's real `testDir`+`testRunner`: pytest, cargo test, go test,
  JUnit, vitest…). Build on that scaffold in that project's conventions — never port agentic-
  kanban's Playwright rules into another repo.
- **generic**: detect the runner from `_test-index.json` (the `runner` field) and match the
  existing tests' structure (imports, fixtures, helpers). Mirror a neighbouring green test.

## Phase 1 — Take the backlog, set the cut line
Read `_priorities.md`. Confirm scope with the user's intent: quick pass → P0–P1 only; "be
comprehensive" → through P5. Pick the top-N gap rows. Each row is already a self-contained spec
(capability, actor, preconditions, entry point, observable outcome, suggested assertions,
dimensions to add) — you should not need to re-derive context. If a row is thin, read the
behaviour in `_behavior-model.json` and its `file:line` evidence; don't guess.

## Phase 2 — Author (one subagent per gap, in waves)
Dispatch a **`general-purpose`** subagent per gap, briefed by `references/generation-brief.md`.
Each subagent writes ONE test (or one tight `describe`) that:
- exercises a **complete, realistic workflow** to the gap's observable outcome — not an isolated
  click. Model real user behaviour; reuse page objects / screen models where the suite has them.
- **asserts business outcomes**, not implementation details. Stable selectors only. No coupling
  to internal state, DOM structure, or volatile copy.
- **declares the coverage dimensions it contributes** in a header comment
  (`// @covers ws.create.busy [error,api]`) — this is what makes the matrix additive and lets a
  re-run credit the new coverage automatically.
- follows Phase-0 conventions exactly (anti-flake rules; cleanup; condition-based waits).
- for negative/boundary/error/permission gaps, pulls concrete cases from
  `references/edge-case-catalog.md`.
Run each new test once to confirm it's green (and that it actually *fails* when the behaviour is
broken — a quick mutation check on at least the P0/P1 tests: if you can't make it red, it isn't
asserting the outcome).

## Phase 3 — Adversarial review (refute, don't confirm)
This is the quality gate the design asks for, stored as a reusable delegated prompt. For each
generated test, dispatch ≥1 independent reviewer subagent (≥3 voting reviewers for P0/P1) using
**`references/adversarial-review.md`**. Each reviewer is told to **break** the test:
- does it assert the behaviour's *outcome*, or would it pass if the behaviour silently broke?
- is it **overfitted** (asserts incidental copy/IDs/ordering that will change on a safe edit)?
- is it **flaky** (race, fixed sleep, unscoped selector, shared state, order-dependence)?
- does it leak state / miss cleanup?
- does it actually cover the **dimensions it declares**, or fewer?
- what edge case adjacent to this gap did it miss?
Reviewer returns `sound | needs-fix | unsound` with specific defects. **Close the loop**: fix
`needs-fix` directly, re-author `unsound`, re-review anything substantially changed. Only `sound`
tests land. Record verdicts in `_authored.json`.

## Phase 4 — Land + close the coverage loop
- Run the surviving tests; confirm green and non-flaky (re-run P0/P1 a few times).
- Write each new test into `_coverage.json`: append to the behaviour's `covered_by`
  (`asserts-outcome`), clear the closed `dimensions_missing`, flip status to `covered`/`partial`.
- **Re-render the living test plan** so its checkbox ticks: `node <coverage-intelligence-skill>/tools/testplan.mjs <verification-dir>` (also `render.mjs` for the matrix/gaps/priorities). The scenario you just closed flips `[ ]`→`[x]` automatically — that is the visible progress signal, the generator checking off the planner's plan.
- Append the run to `_authored.json` and `_verification-log.md`.
- Commit (the project always commits after a task) with a message naming the gaps closed.
- Report: gaps closed (with P-level + dimensions), tests added, review verdicts, and the
  coverage delta (before→after score from `_coverage.json.summary`). If you stopped at a cut
  line, **say what's left** — silent truncation hides remaining risk.

## Existing-test cleanup (when coverage-intelligence flagged it)
If `_gaps.md` carries an audit list (duplicates / flaky / implementation-coupled / obsolete),
action the safe ones in the same pass: delete obsolete, merge duplicates, de-couple brittle
assertions. A smaller, truer suite is part of the deliverable — but only remove a test after
confirming its behaviour is covered elsewhere (check `_coverage.json`).

## Rules
- **Gap-driven, value-first.** Build from `_priorities.md` top-down; never blanket-generate.
- **Assert outcomes, not implementation.** If the test can't be made red by breaking the
  behaviour, it isn't a test — it's a smoke check. Mutation-check the important ones.
- **No new flakiness, ever.** Inherit the project's anti-flake rules; the adversarial pass exists
  to catch what slips through. A flaky test is worse than no test.
- **Declare dimensions.** Every test states what it covers; that's what makes the loop additive.
- **Refute before landing.** Reviewers attack; only survivors land. For P0/P1, majority of ≥3.
- **Close the loop.** Write coverage back into the model, or re-runs will re-find the same gaps.

## Reference files
| File | Use |
|------|-----|
| `../coverage-intelligence/references/verification-model.md` | the shared schema |
| `references/generation-brief.md` | Phase 2 — the per-gap test-author subagent prompt |
| `references/adversarial-review.md` | Phase 3 — the reusable refute-the-test reviewer prompt |
| `references/edge-case-catalog.md` | Phase 2 — concrete edge/negative/boundary cases to pull from |
| `references/existing-test-audit.md` | cleanup — how to safely retire duplicate/flaky/coupled/obsolete tests |
