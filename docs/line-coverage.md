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
  `--lcov-paths`, `--allow-missing`, `--merge [out]` (#797 — one repo-anchored lcov for the
  analyzer, since it accepts only one report; `pnpm coverage:merge`).
- `.github/workflows/arch-gate.yml`, job `coverage` — runs the suite with coverage, runs the reader,
  runs the merge, and uploads the per-package `lcov.info` + `coverage-summary.json` and the
  merged `coverage/lcov.info` as the `coverage-lcov` artifact (14 days).
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

### The first measurement (2026-08-23, client lcov only, 11m22s) — superseded, kept for the delta

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

### The full measurement (2026-08-23, #797, merged four-package lcov, 11m55s)

`provenance.scanners.coverage = ok`, and the basis is now mostly measurement:

```
safety_net_basis_counts  { coverage: 997, test_cochange: 434 }
   #765, client lcov only  { coverage: 225, test_cochange: 1191 }
   #688 era, no report     {               test_cochange: 1375 }
```

997 of 1,431 scored files are measured; `exposure.safety_net_basis` reads `coverage`, and
`safety_net_mean` is 0.6728. The 434 still on the co-change proxy are the files no vitest
project instruments — test files themselves (excluded by every package's `coverage.exclude`),
plus root `scripts/` (46), `packages/e2e` (4), and the markdown/yaml/py/sh files the analyzer
scores but v8 can never see. By module: client 211, shared 72, server 71, scripts 46, root 26,
mcp-server 4, e2e 4.

Run cost: 11m55s for `analyze` on top of the ~28m coverage run.

## The numbers (2026-08-23, #797 — all four packages, this machine)

The first time every package has been measured. `code-metrics analyze --coverage` had been
falling back to the `test_cochange` proxy for everything outside `packages/client`; it no
longer has to.

| package | test files | tests | wall time | files | lines | branches | funcs | files at 0% |
|---|---|---|---|---|---|---|---|---|
| `shared` | 100 | 960 | **2m16s** | 127 | **76.37%** (3214/4208) | 69.63% | 65.18% | 3 |
| `server` | 735 | 6892 | **22m55s** | 652 | **79.14%** (24933/31503) | 68.30% | 74.60% | 34 |
| `mcp-server` | 44 | 206 | **2m03s** | 99 | **48.85%** (979/2004) | 40.90% | 54.97% | 4 |
| `client` | 169 | 1592 | **1m14s** | 257 | **48.98%** (4328/8835) | 43.41% | 39.90% | 29 |
| **TOTAL** | | | **~28m30s** | 1,135 | **71.87%** (33454/46550) | 61.34% | 63.47% | 70 |

`VITEST_MAX_WORKERS=4` for `server`, defaults elsewhere, on a machine running several
concurrent agent sessions. `server` is the whole cost: it is 80% of the wall clock and 68% of
the measured lines. **Time it on a CI runner before moving the arch-gate `coverage` job onto
`pull_request`** — a 23-minute merge gate is a different decision from a 23-minute
informational job, and none of the numbers above are CI timings.

Every one of those four runs had failing tests (`shared` 5 files, `server` 11, `mcp-server` 0,
`client` 2) — unrelated in-flight work from other agents in this shared checkout — and every
one still produced its report. That is new; see below.

### The reason these numbers did not exist before

**`coverage.reportOnFailure` defaults to `false`.** A vitest run with any failing test writes
no coverage report at all. This repo's guard/ratchet suites scan the whole source tree, so in
a checkout where several agents work at once they are red for reasons that have nothing to do
with the package under measurement — which means every attempt to measure `shared`, `server`
or `mcp-server` had silently emitted nothing. #765 burned a 20m49s server run on exactly this
and concluded the package was unmeasurable.

All four packages now set `reportOnFailure: true`. Coverage is a MEASUREMENT, not a gate: a
red suite must still yield its numbers, and the provenance (how many suites failed) belongs
next to the number, which is what the table above does.
`packages/server/src/__tests__/coverage-wiring.test.ts` asserts the flag in all four configs
and is red on a config that omits it.

**Caveat, measured once and unexplained.** The first full `server` run (26m29s, 12 failing
files) still produced no report *with* `reportOnFailure: true`: vitest printed its summary and
exited without running the coverage-reporting phase or the `globalSetup` teardown. The
identical re-run (22m55s, 11 failing files) reported normally, and a deliberate single-file
failing run reported too. So `reportOnFailure` demonstrably works and something else can
occasionally kill the run after the summary. If a server run yields nothing, re-run it before
concluding anything.

### Feeding all four to the analyzer: `pnpm coverage:merge`

`code-metrics analyze --coverage <path>` takes exactly **one** report, and each package's lcov
names its files relative to that package, with Windows separators. A naive `cat` of the four
makes `src/index.ts` ambiguous across packages. lcov is just concatenated records, so merging
is legitimate — it only needs each `SF:` re-anchored to the repo root:

```bash
pnpm test:coverage     # ~28m, all four packages
pnpm coverage:report   # the table; fails if a package emitted nothing
pnpm coverage:merge    # -> coverage/lcov.info, 1,135 files, repo-anchored
code-metrics analyze . --changeset-strategy pr --coverage coverage/lcov.info
```

`mergeLcov` lives in `scripts/coverage-report.mjs` and is unit-tested for the collision case.
The arch-gate `coverage` job runs the merge and uploads `coverage/lcov.info` alongside the
per-package artifacts.

### Measured coverage of the files three refactoring tickets name

The sequencing question #765 asked and could not answer. All ten are in `packages/server`:

| ticket | file | lines | branches | funcs |
|---|---|---|---|---|
| #728 | `services/workspace-services.service.ts` | **65.25%** (139/213) | 52.07% | 48.97% |
| #728 | `repositories/issue.repository.ts` | 82.81% (53/64) | 73.33% | 74.19% |
| #728 | `services/devcontainer-workspace.service.ts` | **67.76%** (82/121) | 61.36% | 73.33% |
| #728 | `services/git-info.service.ts` | 97.54% (159/163) | 79.16% | 89.28% |
| #728 | `services/butler-definitions.service.ts` | 93.10% (81/87) | 73.73% | 96.00% |
| #726 | `services/plugin.service.ts` | 90.38% (47/52) | 85.18% | 88.88% |
| #726 | `services/plugin-loop.service.ts` | 88.88% (40/45) | 82.81% | 75.00% |
| #726 | `services/monitor-cycle.ts` | 78.14% (236/302) | 67.91% | 62.79% |
| #726 | `services/workspace-merge.service.ts` | 85.08% (194/228) | 63.54% | 82.05% |
| #700 | `startup/exit-workflow.ts` | **70.47%** (148/210) | 56.46% | 88.23% |

**None of them is unprotected.** The lowest is 65%, the median 84%, and eight of ten are above
the repo-wide 71.87%. The "cover it before you refactor it" precondition #765 raised for these
three tickets does not bind — they can be started on the tests as they stand. The two worth a
second look are `workspace-services.service.ts` (49% of its functions never called by a test)
and `exit-workflow.ts` (56% branches), where the line number overstates the protection.

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

**That run has happened (#797) — see § The numbers above.** All four packages are measured,
and the answer is that none of the ten files those tickets name is unprotected: 65% lines at
the worst, 84% median. The precondition does not bind; the tickets can start. What the run did
NOT settle is whether the arch-gate `coverage` job belongs on `pull_request` (23 minutes of
`server` on a loaded dev box is not a CI timing) or whether `coverage-report.mjs --min <pct>`
should become a floor. There is now a baseline — 71.87% repo-wide — so setting one is a
decision someone can make, but it has not been made.

## Per-package floor ratchet (#902, #807 follow-up)

#807 rejected a flat `--min` floor: `mcp-server` (48.85%) and `client` (48.98%) sit far below
`server` (79.14%) and `shared` (76.37%), and a floor pinned to today's numbers never rises by
itself. `scripts/coverage-report.mjs --check-floors` is the follow-up — a floor **per package**,
stored in `scripts/coverage-floors.json`, shaped like this repo's other shrink/grow-only ratchets
(`compareRatchet` in `packages/shared/__tests__/helpers/guard-scan.ts`), but inverted: those
freeze a count that may only shrink, this freezes a floor that may only rise.

Two ways it fails:
- **regression** — measured coverage for a package dropped below its stored floor.
- **stale** — measured coverage is now more than the slack (default 2 points) above its stored
  floor. Without this half the floor would sit wherever it started, exactly the #807 objection.

```bash
pnpm test:coverage             # produce the reports first
pnpm coverage:check-floors     # node scripts/coverage-report.mjs --check-floors
```

**Not merge-blocking.** Wired into `.github/workflows/arch-gate.yml`'s `coverage` job, which
already runs only on `push`/`workflow_dispatch` (#807) — this is a red/green *signal* there, not
a new PR gate. When it goes red, raise the offending package's floor in
`scripts/coverage-floors.json` (never lower one except to fix a genuine regression) and land that
alongside the change that raised coverage.
