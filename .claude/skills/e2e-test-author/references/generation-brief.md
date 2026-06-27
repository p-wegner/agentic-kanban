# Generation subagent brief — one gap → one high-value test

You write ONE end-to-end test that closes a specific coverage gap. The gap is fully specified
below — build from it; don't re-scope. Your test must be **green, non-flaky, outcome-asserting**,
and follow the target project's conventions exactly.

## The gap (filled by orchestrator, from `_priorities.md`)
- **Behaviour**: `{{behavior_id}}` — {{statement}}
- **Capability / actor**: {{capability}} / {{actor}}
- **Priority / dimensions to add**: {{P}} / {{dimensions}}
- **Preconditions**: {{preconditions}}
- **Entry point**: {{entry_point}}  ({{ui_or_api}})
- **Observable outcome to assert**: {{observable_outcome}}
- **Suggested assertions**: {{assertions}}
- **Evidence**: {{file_line}}  · existing partial coverage: {{partial_test_or_none}}

## Project conventions (filled by orchestrator)
- **Runner / test dir**: {{runner}} / {{test_dir}}
- **Anti-flake rules**: {{rules}}  ← follow ALL. For agentic-kanban these are the `e2e-author`
  RULES 1–8 (127.0.0.1; ports from helpers; `getE2EProjectId` not `projects[0]`; scoped
  selectors; `Date.now()` suffix; mandatory `afterAll` cleanup; retry-not-skip; no fixed sleeps).
- **A neighbouring green test to mirror**: {{exemplar_test}}  ← copy its structure/imports/helpers.
- Do **not** run `playwright install` / install browsers.

## How to write it
1. **Model a complete, realistic workflow** to the observable outcome — arrange via API where
   that's faster/deterministic, act through the real entry point, assert the *outcome*. Not an
   isolated click; a journey a real actor would take.
2. **Assert business outcomes, not implementation.** Assert the status/body/visible-state/diff/
   exit-code the behaviour produces. Never assert internal data shapes, DOM nesting, nth-child,
   or volatile copy. Stable selectors only (role/label/aria/test-id/scoped parent).
3. **Cover the declared dimensions** and nothing it can't honestly assert. For error/negative/
   boundary/permission gaps, take concrete cases from `edge-case-catalog.md`.
4. **Header comment declaring coverage** — first line inside the test/describe:
   `// @covers {{behavior_id}} [{{dimensions}}]` — the loop reads this to credit coverage.
5. **Cleanup is mandatory.** Track every created id; delete in `afterAll`; reset any mutated
   pref/setting. No state leaks between runs.
6. **Condition-based waits only.** `expect(locator).toBeVisible()`, `expect.poll(...)` on an API
   field, `waitForFunction` — never a fixed sleep for correctness.

## Boundaries (the orchestrator owns these — do NOT cross them)
- **Write ONLY your test file** (+ a small fixture if unavoidable). Do **not** edit
  `docs/verification/*` (the coverage model) — the orchestrator closes the loop from your
  returned result. Concurrent generators editing the shared model corrupts it.
- **Do NOT `git commit`, `git checkout`, `git reset`, or WIP-stash** anything. The orchestrator
  commits. If a merge-based test reports a dirty-main `409`, report it — do not "set aside" other
  agents' files with WIP commits to force a clean run.

## Self-check before returning (this is what the reviewer will attack)
- **Mutation check**: would this test go RED if the behaviour broke? If you can't convince
  yourself it would, it asserts the wrong thing — fix it. For P0/P1, actually reason through the
  break (e.g. "if the endpoint returned 200 instead of 409, line N fails").
- Re-read the anti-flake rules against your file: no `projects[0]`, no `localhost`, no hardcoded
  ports, no `test.skip()` on setup, no fixed sleep, scoped selectors, cleanup present.
- Run it once; confirm green.

## Return
The test file path + the `@covers` line + a one-paragraph note: what workflow it models, why it
would fail if the behaviour regressed, and any dimension in the gap you could NOT honestly assert
(so the orchestrator keeps that dimension open rather than falsely crediting it).
