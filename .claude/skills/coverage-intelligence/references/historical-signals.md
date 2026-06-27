# Historical signals — churn + bug history → regression premium

Past failure predicts future failure. These signals seed `regression_value` (and sharpen
`risk`) in prioritization, so the highest-ROI tests cluster where the code actually breaks.

## Signals to collect (deterministic, cheap)
1. **Churn (90d)** — commits touching each source file. From `git log` or reuse code-metrics
   (`code-metrics-out/analysis.json` already has per-file churn). High churn = the behaviour's
   implementation moves a lot = higher chance a change regresses it.
   ```
   git -C <repo> log --since=90.days --name-only --pretty=format: -- <paths> | sort | uniq -c | sort -rn
   ```
2. **Bug history** — issues/commits labelled fix/bug touching a capability's files. From the
   kanban board (`list_issues` for bug-type / `fix(` commits) or `git log --grep='fix\|bug'`.
   A behaviour whose files have a history of fixes is regression-prone.
3. **Last regression** — the most recent fix commit per behaviour area; ties a P5 regression-lock
   to a concrete past failure (the test's reason-to-exist).
4. **Hotspot overlap** — code-metrics `refactor_first` / high blast-radius files. A behaviour
   implemented in a hotspot is both high-impact and high-regression — push it up.

## Turning signals into scores
- `regression_value` (1–5): map churn percentile + bug count. e.g. top-decile churn OR ≥2 past
  bugs ⇒ 5; no churn, no bugs ⇒ 1.
- Feed `history` into each `_coverage.json` behaviour: `{ churn_90d, bugs, last_regression }`.
- A behaviour that is **uncovered AND high-regression** is the textbook P0/P1 — the suite has no
  guard exactly where the code keeps breaking. Surface these explicitly as "regression-prone &
  unverified" at the top of `_gaps.md`.

## Bug-area → regression test (P5)
For each historical bug you can pin to a behaviour, propose a P5 regression-lock that asserts
the *specific* past failure cannot recur, tied to the bug id. This is the cheapest high-value
test category: the failure is already known and reproducible.

## Caveats
- Churn without bugs can mean healthy iteration, not fragility — weight bug history higher than
  raw churn when both are available.
- New code has no history; don't score it 1 by default — fall back to `risk` (blast radius) so a
  brand-new high-blast behaviour still ranks.
- If neither git history nor a tracker is available (shallow clone, fresh repo), say so and fall
  back to `risk` alone; don't fabricate a regression score.
