# Line coverage: how it is produced, who reads it, what it is for

Not to be confused with [`coverage-gaps.md`](coverage-gaps.md), which is a hand-maintained
*behavioural* coverage snapshot (which API routes and workflows have tests at all). This page is
about **line/branch coverage measured by running the suite** — the numeric report, where it lands,
and the one consumer that makes it worth producing.

## Why it exists (#688 → #765)

#688 installed `@vitest/coverage-v8`, added a `coverage` block to all four test packages and a root
`pnpm test:coverage`. Nothing then read the output for months, and #765 found the capability was
worse than unused — it was **broken and silent**:

- **The script did not work.** It was `pnpm --filter … test -- --coverage`. pnpm swallows
  everything after `--` in that form. Measured 2026-08-23:
  `pnpm --filter @agentic-kanban/client test -- --coverage --reporter=dot src/lib/__tests__` ran
  **all 165 files** with the default reporter and produced **no `coverage/` directory at all**.
  A script that runs the whole suite and emits nothing looks like it worked.
- **Nothing consumed a report.** No workflow and no script mentioned `lcov`/`coverage-final`, so
  `code-metrics analyze` found no report (`provenance.scanners.coverage = "skipped:no_report"`) and
  fell back to its **co-change proxy** for **1,375 of 1,375** production files. Every
  "is this file protected" number the repo produced actually meant *"was this file ever committed in
  the same change set as some test file"*.

That proxy is not just imprecise, it is wrong in the direction that matters. `GraphEdges.tsx` was
one of the three files the analyzer scored at `safety_net = 0.00` ("never once co-changed with a
test"). Its **measured line coverage is 88% (22/25)**. A refactoring plan built on the proxy would
have sent someone to write tests for a well-covered file.

## Producing the report

```bash
pnpm test:coverage      # all four test packages, coverage on
pnpm coverage:report    # read what they emitted (fails if a package emitted nothing)
```

Per package, the artifacts land in `packages/<pkg>/coverage/` (gitignored):

| File | Reporter | Read by |
|---|---|---|
| `lcov.info` | `lcov` | `code-metrics analyze --coverage` |
| `coverage-summary.json` | `json-summary` | `scripts/coverage-report.mjs` |
| `lcov-report/` | `text`/html | humans only; never uploaded as an artifact |

The coverage blocks live in `packages/{shared,server,mcp-server}/vitest.config.ts` and — this is
the one people get wrong — **`packages/client/vite.config.ts`**. The client has no
`vitest.config.ts` and never had one; #765's source ticket concluded from its absence that the
client had been left out of #688, and it had not been.
`packages/server/src/__tests__/coverage-wiring.test.ts` asserts the location so that conclusion
cannot be re-derived.

The correct invocation for one package is `pnpm exec vitest run --coverage` **from inside the
package** (or `pnpm -r --filter … exec vitest run --coverage` from the root, which is what
`test:coverage` does). `pnpm <pkg> test -- --coverage` silently does nothing.

## Who reads it

- `scripts/coverage-report.mjs` — the consumer of record. Prints a per-package and repo-wide table,
  names the lcov paths to feed the analyzer, and **exits non-zero when a package that runs tests
  emitted no report**, because #688's failure mode was silence. `--json`, `--min <pct>`,
  `--lcov-paths`, `--allow-missing`.
- `.github/workflows/arch-gate.yml`, job `coverage` — runs the suite with coverage, runs the reader,
  and uploads `lcov.info` + `coverage-summary.json` as the `coverage-lcov` artifact (14 days).
  **It does not run on pull requests** (`if: github.event_name != 'pull_request'`) — only on pushes
  to master and on `workflow_dispatch`. A full-repo coverage run is the entire suite (~4,100 server
  tests that spawn real git/node children, plus 1,541 client tests), and the vitest configs in this
  repo exist largely to document how that suite behaves under load (#206, #680: timeouts turning a
  green tree into a board-wide red merge gate). A coverage number is worth having; it is not worth
  withholding every merge for. Moving it onto PRs is a one-line change — do it after measuring the
  run on a CI runner, not on the strength of a local timing.

## Feeding the analyzer

```bash
code-metrics analyze . --changeset-strategy pr --coverage packages/client/coverage/lcov.info
```

`--coverage` accepts one report path (Cobertura/LCOV/JaCoCo/Clover); it also auto-discovers. With a
report present, the analyzer's `exposure` block reports `safety_net_basis` as real coverage for the
files the report covers instead of `test_cochange`, and `exposure = difficulty × (1 − safety_net)`
becomes a measurement. Files the report does **not** cover keep the co-change proxy, so a *partial*
report yields a mixed basis — `safety_net_basis_counts` says which files got which, and that field
is the thing to read before believing any exposure ranking.

### The measurement, made (2026-08-23, client lcov only, 11m22s)

`provenance.scanners.coverage` went from `skipped:no_report` to `ok`, and the basis split:

```
safety_net_basis_counts  { coverage: 225, test_cochange: 1191 }   (was { test_cochange: 1375 })
```

225 files became measured off **one** package's report. The exposure ranking changed materially,
which is the point — a proxy that reorders the worklist is not a conservative approximation:

| | Proxy ranking (#765's ticket) | Measured |
|---|---|---|
| `components/GraphEdges.tsx` | 3rd worst, `safety_net 0.00`, exposure 0.238 | **out of the top 30**; 88% lines covered |
| `settings/PluginsSettings.tsx` | not listed | **worst in repo**, exposure 0.335, 1.2% covered, max CC 35 |
| `components/PluginSkillPane.tsx` | not listed | **2nd**, exposure 0.304, **0% covered**, max CC 39 |
| `hooks/useCrossRepoActivity.ts` | not listed | 5th, 1.6% covered, max CC 32 |

The two genuinely worst-protected complex files in the repo were invisible to the co-change proxy,
and the file it pointed at was well covered. `scripts/analyze-claude-session.mjs` stays 3rd on
`test_cochange` — see below.

## What coverage can never tell you here

Root `scripts/*.mjs`, `packages/e2e` and `packages/desktop` are owned by no vitest project, so a v8
run cannot see them at all. Two of the three files #765 headlined as `safety_net 0.00` are
`scripts/analyze-claude-session.mjs` (CC 46) and `scripts/analyze-codex-session.mjs` (CC 45) —
they are **out of scope of every report**, and absence from the report is not 0% coverage. For those
files the co-change proxy remains the only signal, and "genuinely untested" is still an open
question. `scripts/coverage-report.mjs` prints this caveat on every run so nobody reads a blank as a
zero.

## Sequencing (the reason the ticket mattered)

Unprotected code should be covered **before** it is refactored. Three open tickets propose
refactoring code whose protection was unknown at the time they were written: #726 (gate design,
naming `plugin.service.ts`, `plugin-loop.service.ts`, `monitor-cycle.ts`,
`workspace-merge.service.ts`), #728 (95 split-responsibility candidates, top five all server
services/repositories) and #700 (`startup/exit-workflow.ts`). Every file those tickets name is in
`packages/server`, so the useful move before starting any of them is a server coverage run and a
look at the per-file numbers — not another pass over the co-change ranking.

**That run has not happened.** Only `packages/client` has ever been measured, so every server file
— including all of #726's, #728's and #700's — is still scored on the proxy that was just shown to
reorder the worklist. #797 tracks it: run all four packages, record the wall time, and report the
measured coverage of those files so the refactoring tickets can be sequenced behind test-writing
where the number is low.
