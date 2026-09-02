# Test strategy as practised — agentic-kanban, 2026-09-02

Produced by the `test-strategy` skill (ticket #999) against
`9bde4f639abaf9a671d6236d21decb9316a26b05`, tree clean. Every number below comes from
`code-metrics` (engine 0.2.0); nothing in this document was counted by hand. Where a
sentence is the agent's reading rather than a measurement it is labelled **[reading]**.

Artefacts: `.code-metrics/run/` (before), `.code-metrics/run3/` (after the coverage report
and the vocabulary contribution), `.code-metrics/agent-vocabulary.json` (the contribution).

---

## Part 1 — The lift

What the engine could not measure before this pass, and can now.

### Coverage: the largest dark channel is closed

`coverage.status` went **`skipped:no_report` → `ok`**.

| | Before | After |
|---|---|---|
| `coverage.status` | `skipped:no_report` | `ok` (lcov, `merged_single_report`) |
| union line coverage | — | **72.3%** (36,781 / 50,856) over 1,248 files |
| `instrumented_share` | 0.0% | **67.9%** of 1,829 production files |
| `exposure.safety_net_basis` | `test_cochange` | **`coverage`** |
| `safety_net_basis_counts` | `{test_cochange: 1568}` | **`{coverage: 1115, test_cochange: 453}`** |
| `safety_net_mean` | — | 0.7477 |

That last row is the consequential one: 1,115 of 1,568 scored files no longer rest on the
co-change proxy — the measure that only ever meant *"was this file ever committed alongside
some test file"*. `docs/line-coverage.md` already records what that proxy costs
(`GraphEdges.tsx` scored `safety_net 0.00` on it against a measured 88%), so this is a
restoration of a capability the repo had documented, not a new one.

**Per package, as run** (all four, this machine, `VITEST_MAX_WORKERS=4` for server):

| package | test files | tests | lines | branches | funcs |
|---|---:|---:|---|---:|---:|
| `shared` | not captured † | not captured † | **75.70%** (3494/4615) | 66.39% | 66.60% |
| `server` | 851 (3 failed) | 8,376 (5 failed, 6 skipped) | **79.09%** (27809/35157) | 68.67% | 74.83% |
| `mcp-server` | 44 | 206 | **48.65%** (977/2008) | 40.41% | 55.65% |
| `client` | 183 | 1,746 | **49.59%** (4502/9077) | 44.01% | 40.61% |

† The `shared` run's summary line scrolled out of the captured output before I read it; its
coverage figures come from its own `coverage-summary.json` and are unaffected. I record the
gap rather than back-fill a count I did not observe.

The four per-package lcov files were merged with the repo's own `pnpm coverage:merge`
(1,280 files) and handed to `analyze --coverage`, which parsed and stamped it itself.

**Declared limits of this report, per the skill's rules:**

- **It is one aggregate report, so it cannot say which tier earned the coverage.**
  `delivering_tier` reads `unmeasured:aggregate_report_only` and the pyramid's coverage
  denominator stays disabled. Lighting those needs `[[coverage.reports]]` declared per tier
  in `.codemetricsrc`, which needs the tiers to be separately runnable — they are not today
  (see "the tiers are not declared", below).
- **`covered_but_unasserted` stays `skipped:single_tier`** — it needs a tier declared
  `assert_weak` to accuse, and none is.
- **`instrumented_share` is 0.679, not 1.0.** The 453 files still on the co-change proxy are
  the ones no vitest project instruments: test files themselves (excluded by every package's
  `coverage.exclude`), root `scripts/`, `packages/e2e`, and the non-JS files the analyzer
  scores but v8 cannot see. That number belongs beside every percentage above.
- **The server run failed 5 tests in 3 files** and its report is included anyway, which is
  the deliberate design of this repo's `reportOnFailure: true` (#797). Reported as failing,
  not retried until green, nothing edited to make it pass. The three:
  `monitor-cycle-progress-marker.test.ts` (`waitUntil timed out`),
  `monitor-file-contention.test.ts` (2 tests, a mocked `fetch` never called),
  `stop-hook-typecheck-inflight.test.ts` (expected `case: IN FLIGHT`).
  **[reading]** All three are load- and timing-sensitive suites of exactly the class this
  repo's own vitest configs were written to document (#206, #680: "the budget was measuring
  CPU contention rather than correctness"), running here on a box at ~1.2 GB free RAM with
  several agent sessions live. I did not confirm them green in isolation, so I state them as
  *failing in this run* and as *probably load artefacts*, not as either/or.

- **One further pre-existing failure, confirmed NOT a load artefact.** The verification run
  for this ticket (`pnpm test:mine`, 8,275 passed / 1 failed) failed
  `workspace.service.test.ts > … fails LOUDLY when composeRepo doesn't resolve` (#15) —
  `expect(sessionManager.startSession).toHaveBeenCalledOnce()` got 0 calls. It **also fails
  run alone** (1 failed / 51 passed), so it is genuine red debt, not contention. It is
  unrelated to this ticket: the last change to that test and its service (`dd0995cc4e`, #859)
  is an ancestor of the analysed commit, and this ticket's diff is one markdown file, one
  JSON data file and one `.gitignore` line — none in that test's import graph. Recorded here
  rather than fixed, per scope.

### The vocabulary contribution: 2 entries, both applied

`.code-metrics/agent-vocabulary.json`, contract `agent-vocabulary/1`, verified by the engine
on re-analysis: **applied 2, rejected 0, stale 0**.

| id | family → classification | verdict | reach |
|---|---|---|---|
| `ak-createtestdb-fresh-file-per-call` | `state_isolation` → `fresh_database_per_test` | `ok`, applied | 2 files |
| `ak-createtestdb-callsite-db-boundary` | `dependency_treatment` (`db`) → `real` | `ok`, applied | **403 files** |

**The first pass of both entries was `rejected:not_a_literal`** and is recorded here rather
than quietly fixed: my initial tokens were `copyFileSync(templatePath, file)` and
`from "./helpers/test-db.js"`, both carrying regex metacharacters. Re-derived from the same
code as `test-db-template-` (`helpers/test-db.ts:169`) and `helpers/test-db`
(`workspace-merge-service.test.ts:17`), both verified `ok`. The verifier did its job; the
entries were wrong and were fixed from the code, not argued with.

**What this bought, concretely — the `unobserved` db cell became measured:**

| Boundary | Tier | Treatment | Files | Provenance |
|---|---|---|---:|---|
| `db` | `integration` | `in_memory` | 17 | engine (E3) |
| `db` | **`unit`** | **`real`** | **337** | agent_supplied |
| `db` | `integration` | `real` | 53 | agent_supplied |
| `db` | `ambiguous` | `real` | 1 | agent_supplied |

Before this pass the matrix had exactly one db row (17 files, `in_memory`). **337 unit-tier
files provably touch a real migrated SQLite database** — see Part 3, where that is the
headline finding.

And the isolation table, which previously matched nothing at all
(`recognised_share: 0.0`, "17 unrecognised"), now names the mechanism:

```
fresh_database_per_test:
  agent: { files: 2, tiers: ["unit"], provenance: "agent_supplied",
           token: "test-db-template-", line: 169,
           contribution_id: "ak-createtestdb-fresh-file-per-call" }
```

### The engine's disagreements with me — 12 rows, and the engine is right

Twelve files are published in `agent_contribution.disagreements[]`: my entry says the `db`
boundary is treated `real`, the engine's E3 rung says `in_memory`. Per the contract the
built-in stands.

**[reading] The engine is correct and my entry was imprecise, but not wrong.** Those twelve
(`merge-gate-extraction.repo.test.ts`, `conflict-cache-extraction.repo.test.ts`,
`migration-schema-drift.test.ts`, …) genuinely use **both**: they import `createTestDb` for
the round-trip assertions *and* construct a separate `createClient({ url: ":memory:" })` for
the migration-backfill assertion — verified at `merge-gate-extraction.repo.test.ts:155`.
A per-file single-valued treatment cannot express "both", so the disagreement is an artefact
of the cell shape, not of either party being mistaken. Reading the disagreement rows was
worth more than the row they disagree with.

### What did NOT close, and why

`open_questions` still carries three entries. One genuinely narrowed, two did not:

- **`isolation.unrecognised` — narrowed in kind, worse in ratio, and this needs explaining.**
  `db_touching_files` went **17 → 409** *because* my treatment entry made 403 more files
  visible as db-touching; `unrecognised_files` is now 407 and `recognised_share` 0.005. That
  looks like a regression and is not: the population grew by two orders of magnitude while
  the isolation token still only matches the helper that *implements* the mechanism, not the
  403 callers that inherit it. **This is the documented v1 boundary of the channel** —
  `docs/contracts/agent-vocabulary-1.md` lists "helper attribution over the import graph
  (*files importing `TestDb.kt` inherit its evidence*)" as deliberately outside this version.
  No honest entry closes it today: the callers carry no isolation token of their own, and
  inventing one would be contributing a conclusion dressed as a token.
- **`harness.e5_fallthrough` — untouched at 1,116 files.** The engine's own note says the
  honest answer for genuinely-unit files is a `[tests.tiers]` declaration, not a token, and
  no `harness` classification (`e2e`/`integration`) fits the majority. See Part 3.
- **`count.extent_floor` — not actionable**, no family exists. Every test count in this
  document is a **floor**.

---

## Part 2 — Declared vs practised

The repo makes falsifiable claims about its own testing. Quoted verbatim, with the
measurement beside them.

> "Every feature must be verifiable through automated tests that an AI agent can run,
> interpret, and use as feedback for iteration."
> — `docs/prd/06-testability-strategy.md:6`

**[reading]** Structurally honoured, and unusually so. `pnpm test:mine`, the test-impact
selection and the pre-merge gate exist precisely to make the suite agent-runnable.

> "**Unit Tests (Vitest)** — In-memory SQLite database for isolation"
> — `docs/prd/06-testability-strategy.md:26`

> "`db = createTestDb(); // in-memory SQLite with migrations applied`"
> — `docs/prd/06-testability-strategy.md:52`

**Contradicted by the code, twice over.** `createTestDb` is **file-backed**, deliberately,
with the reason written at `packages/server/src/__tests__/helpers/test-db.ts:230-241`: libsql
"loses an in-memory database across a `db.transaction()` commit", which "made every
transactional cascade test baseline-red". The isolation is not in-memory-ness — it is a
fresh copied template file per call (line 252). This is a doc that is stale about a decision
its own code documents at length.

> "Factory-style test data setup" — `docs/prd/06-testability-strategy.md:27`

**Measured `factory: 0`, `builders: 2`, `inline_literals: 91.9%`.** But this is a
**vocabulary limit, not an absence** — the engine says so itself ("data built by helper
functions with non-signalling names is invisible"). A real shared data layer exists; it is
just named `seed*` / `create*Directly` rather than `*Factory`: `seedProject`, `seedIssue`,
`seedWorkspace`, `seedLinearWorkflow`
(`packages/server/src/__tests__/helpers/workflow-test-helpers.ts:17-83`),
`createProjectDirectly`, `createStatusDirectly`, `makeTempRepo`. **[reading]** The doc's
claim is substantively true and the metric's `0` should not be read as its refutation.

> "263 tests covering: tags CRUD, preferences, issue numbers, API routes, git service"
> — `docs/prd/06-testability-strategy.md:28`
> "~212 tests covering: API endpoints, UI interactions, MCP tools, board events, sessions"
> — `docs/prd/06-testability-strategy.md:34`
> "**76 unit tests** (Vitest) … **~120 E2E tests** (Playwright)"
> — `docs/prd/05-mvp-scope.md:164-165`

**Stale by an order of magnitude.** Measured: 3,509 tests in 1,315 files (a floor), and the
server package alone ran **8,376** tests in this pass. These are frozen counts in a
living document; they should be a pointer to how to measure, not a number.

### The declared coverage policy

**There is none.** The engine searched `js_jest`, `js_vitest`, `js_nyc`, `python`,
`jvm_jacoco`, `codecov`, `sonar`, `dotnet_coverlet`, `ruby_simplecov`, `php_phpunit`, `go`
and found **no coverage threshold declared anywhere**. Nothing fails a build for dropping
coverage.

**[reading] That is a deliberate, documented decision here, not an oversight** —
`packages/server/vitest.config.ts:52-55` states it outright: "no threshold is set, so a
low/dropping number is visible but never fails the gate on its own", and
`docs/line-coverage.md` calls coverage "a MEASUREMENT, not a gate". Because no policy is
declared, the policy-gap join stays `skipped:no_declared_policy` — a finding about the repo,
and in this case the intended one.

---

## Part 3 — The characterisation

**[reading]** This is a **large, integration-heavy TypeScript monorepo suite wearing unit-test
directory names.** Its centre of gravity is the server package: ~750 of its test files sit in
one flat `src/__tests__/` directory, and a third of them boot a real migrated SQLite database
through one shared helper. Doubles are rare and state assertions dominate everywhere
(interaction share 4.2% at the unit tier, 0.0% at every other) — this is a **classical /
Detroit** suite almost without exception, and where it fakes, it fakes *time* (26 files) and
*process boundaries*, never its own collaborators. On top of that sits a genuinely separate
Playwright e2e tier (107 files) and an unusual third thing: a large population of
**guard/ratchet suites** that assert properties of the repo tree itself.

### One paragraph a new joiner can act on

Write your test in `packages/<pkg>/src/__tests__/`. If it needs data, call `createTestDb()`
and the `seed*` helpers — you get your own throwaway migrated SQLite file, so you never need
to clean up and never collide with another test. Assert on returned state, not on mock calls.
If your test asserts something about the *repo* (a naming rule, a layering rule, a file that
must exist), mark it `// @gate:always-run` or the scoped runner will silently skip it.

### The layers

Shape is **`pyramid`** — but read the denominator.

| Tier | Tests | Files | Test LOC | Share (suite) | Source |
|---|---:|---:|---:|---:|---|
| `unit` | 2,873 | 1,107 | 151,371 | 81.9% | detected |
| `e2e` | 320 | 107 | 17,097 | 9.1% | detected |
| `integration` | 314 | 110 | 20,729 | 8.9% | detected |
| `ambiguous` | 2 | 1 | 303 | 0.1% | detected |

Three caveats, each load-bearing:

1. **By test COUNT, the weakest of the three denominators.** The engine says so; the runtime
   and coverage denominators are dark (one aggregate report; no duration channel).
2. **Every count is a FLOOR.** `test_count_crosscheck` reports the function-extent parser
   recovering 0.20–0.30 of lexically declared tests in `.mjs`/`.ts`/`.tsx` (e.g.
   `dev-script.test.mjs`: parser 10, source 68).
3. **The `unit` share is largely unevidenced.** 1,116 of 1,325 files reached only rung **E5**
   — path convention. `unit` is never positively evidenced, only fallen through to.

### The tiers are not declared

`tier_declaration: absent`. Nothing in `.codemetricsrc` states which paths are which tier, so
every label is inferred. This is the single change that would most improve every other number
here: it lights per-tier coverage, the pyramid's real denominator, and delivering-tier
attribution.

**The engine already found 109 files whose directory lies** — `path_says: unit`, measured
`integration` at rung E2 (harness boot), all of them Hono `app.request(` API suites in
`src/__tests__/`. I verified that the E5 residue and the `app.request(` set are **disjoint**
(0 overlap), so the E5 bucket is not hiding a second population of HTTP-booting tests.

### What is a "unit" in this project?

**[reading]** There is no single answer; stated as a distribution over what I read, with a
modal answer. I classified the 1,116 E5 files by what they actually touch:

| What the E5 file reaches | Files | Share |
|---|---:|---:|
| a real migrated SQLite DB (`createTestDb`) | **332** | 30% |
| spawns a real child process | 43 | 4% |
| neither — in-process, pure | 741 | 66% |

**The modal "unit" is a pure in-process test of a function or a React component** — e.g.
`Icon.render.test.tsx` uses `renderToStaticMarkup` with no jsdom, which
`packages/client/CLAUDE.md` names as the client's convention for a pure component. But
**30% of what this repo calls a unit test opens a database**, which under most definitions
is an integration test. That is the sharpest gap between the vocabulary and the practice.

### Mockist or classical, and where the boundary falls

A lean per tier, never a repo verdict:

| Tier | Files measured | Interaction-dominant | State-dominant | Mixed | Interaction share |
|---|---:|---:|---:|---:|---:|
| `unit` | 1,080 | 45 | 923 | 112 | **4.2%** |
| `integration` | 109 | 0 | 96 | 13 | 0.0% |
| `e2e` | 105 | 0 | 105 | 0 | 0.0% |
| `ambiguous` | 1 | 0 | 1 | 0 | withheld — low_basis |

**[reading] Decisively classical/Detroit, and the boundary falls at the process edge, not at
the object edge.** The 45 interaction-dominant files are where a real side effect cannot be
allowed (spawning agents, HTTP, hooks). Internal collaborators are not mocked — they are
constructed, which is what the `deps`-object injection seam in `packages/server/CLAUDE.md`
exists to enable. Mock density is a median of **0** at every tier; the mocked-test share
rises monotonically toward the unit tier (17.4% unit, 9.6% integration, 6.6% e2e), which is
the textbook-correct direction.

### How external dependencies are treated

| Boundary | Tier | Treatment | Files |
|---|---|---|---:|
| `db` | `unit` | `real` | 337 † |
| `db` | `integration` | `real` | 53 † |
| `db` | `integration` | `in_memory` | 17 |
| `db` | `ambiguous` | `real` | 1 † |
| `fs` | `unit` | `real` | 242 |
| `fs` | `integration` | `real` | 25 |
| `fs` | `e2e` | `real` | 9 |
| `clock` | `unit` | `fake` | 24 |
| `clock` | `integration` | `fake` | 2 |

† agent_supplied, this pass.

**[reading] The pattern is coherent and deliberate: fake time, use everything else for real.**
The clock is the one boundary consistently faked — which matches the `now?: string` /
`nowMs?: number` injection convention the root `CLAUDE.md` mandates and a ratchet test
enforces. The filesystem is used for real in 276 files, against real temp directories.
`http`, `queue` and `cache` rows are absent, i.e. `unobserved` — and per the engine's own
warning that is **not** evidence the real thing is used, only that no recognised treatment
appeared.

### How stateful tests isolate

**`fresh_database_per_test`** — every `createTestDb()` call copies a pre-migrated template
DB to a per-call `test-db-<uuid>.db` and opens libsql on it
(`helpers/test-db.ts:250-253`). There is no rollback, no truncation, no reset, because there
is nothing to reset: each caller owns its own file.

**[reading] This is a genuinely good isolation story with one honest wart**, and the wart is
documented in the helper rather than hidden: 248 files call `createTestDb`, **7 ever call
`dispose()`**. The helper compensates with a process-exit sweep and an `ak-`-namespaced temp
directory so an external reaper can recover what a killed vitest worker leaks — after
**518,112** stray `test-db-*` entries were measured in `%TEMP%` (#840). Isolation between
tests is sound; lifecycle hygiene is handled by a backstop rather than by callers.

`recognised_share` remains 0.005 over 409 db-touching files — a vocabulary/attribution
limit, explained in Part 1, **not** a finding that 407 files are unisolated.

### How test data is built

| Kind | Files | Share |
|---|---:|---:|
| `inline_literals` | 1,218 | 91.9% |
| `fixture_files` | 3 | unmeasured |
| `builders` | 2 | 0.2% |
| `factory` | 0 | 0.0% |

**[reading]** The 91.9% is a lexical proxy and runs hot on API suites where request/response
JSON is literal by nature — which describes a large share of this suite. The real shape is
**a thin shared seeding layer over mostly-inline literals**: `seedProject`/`seedIssue`/
`seedWorkspace` plus per-file local helpers (`seedWorkspace` in `session-artifacts.test.ts`
is a good example — a private function, not a shared factory). `ensureTestStatus` exists
because per-item seeding against one project used to insert duplicate statuses (#668), which
is the classic pressure that produces a factory layer. The repo has stopped one step short of
naming that layer.

### Patterns, skips, scaffolding, mass

- **Patterns:** `parameterised` 36 files (2.7%), `snapshot` 1, `property_based` 0,
  `contract` 0, `golden` 0. AAA is deliberately not detected.
- **Skips:** 7, all unconditional. **[reading]** Trivially low (0.2% of files) and a genuine
  ratchet — nothing is being hidden here.
- **Scaffolding:** 17 helper files, fixture share 0.6% of test SLOC, max depth 4, median 0.
  Busiest helper is `helpers/test-db.ts` at **27.4%** of measured test files.
  **[reading]** Concentration without depth: one very widely-used helper, a flat tree
  otherwise. A single edit to `test-db.ts` can turn a quarter of the suite red — which is a
  fair price for the isolation property it provides, but it is the highest-leverage file in
  the test tree and should be treated as such.
- **Mass:** **0.797** test SLOC per production SLOC (189,500 / 237,706) — mid-band.
- **Runtime:** **unmeasured** — no duration channel exists. What would make it measurable is
  a per-tier timing artefact; I decline to estimate it from file counts. What I *can* report
  is the wall clock of the runs I actually did: client 84s, mcp-server ~2m, shared ~5m,
  server ~23m, all with coverage on.
- **Co-evolution:** 72.0% of the 1,259 change sets touching production also touched a test;
  median 516 test lines per co-evolved set. By module, lowest first: `scripts` 60.2%,
  `client` 66.3%, `root` 68.3%, `mcp-server` 83.2%, `server` 84.8%, `e2e` 88.9%,
  `shared` 89.2%.

---

## Part 4 — Incoherences

Most consequential first. Each is a fact about the codebase, not a preference.

1. **A third of the "unit" suite opens a database.** 332 E5-classified files call
   `createTestDb`; the treatment matrix now attributes 337 `unit`-tier files to a `real` db.
   Consequence: the pyramid's 81.9% unit share is not 81.9% of *isolated* tests, and the
   suite's runtime profile (server: 23 minutes) is explained by this rather than by test
   count. Not necessarily wrong — a repo whose core value is persistence logic *should* test
   against a real schema — but the label is not describing the practice.

2. **The declared strategy document contradicts the code on the single most-used helper.**
   `06-testability-strategy.md:26` and `:52` both say in-memory; `test-db.ts:230-241` says
   file-backed and explains at length why in-memory was abandoned. A doc that is wrong about
   the mechanism a quarter of the suite runs through is worse than a doc that is silent.

3. **Two documents publish frozen test counts that are ~10-40× stale** (76 / 263 / ~212 /
   ~120 against a measured 3,509 floor and 8,376 server tests in one run).

4. **The tiers are inferred, never declared** (`tier_declaration: absent`), and 109 files are
   already known to have directories that lie about them. Every tier-derived number in this
   report inherits that uncertainty.

5. **`.codemetricsrc` excludes `docs/**` while this report lives in `docs/analysis/`.**
   Deliberate and correct for churn analysis, but worth stating: this document is invisible
   to the tool that produced it.

---

## Part 5 — Instrument findings

Where my reading disagreed with the measurement. Reported with the file and the token, not
silently corrected.

1. **`sleepy` fires on `setImmediate`, which is the opposite of a sleep.** The
   top-ranked smelliest test — `merge-lock-serialization.test.ts:39`, flagged
   `assertion_dense, many_calls, sleepy, external_resource` — contains **no** `setTimeout`,
   `sleep` or `delay` anywhere. What it has is `await new Promise((r) => setImmediate(r))`
   (lines 67, 88, 89): a deterministic microtask-queue yield used to order concurrent lock
   acquisitions, which is precisely how one writes a *non*-timing-dependent concurrency test.
   Scope, measured: **5 test files** reach only for `setImmediate`/`process.nextTick` with no
   real sleep call; 2 use both; 116 use a real sleep. So the proxy is right about the large
   majority and wrong about a small, identifiable class — and it is wrong about the file it
   ranks **first**.

2. **`factory: 0` reads as "no factories" and means "no files named like factories."**
   Covered in Part 2. The engine documents this blind spot itself; the risk is a reader
   taking the `0` as a finding.

3. **The `db` treatment cell cannot express "both".** Twelve files legitimately use a
   file-backed DB *and* a `:memory:` client for different assertions. The single-valued cell
   forced a disagreement row where there is no actual disagreement about the code.

4. **`db_touching_files` grew 17 → 409 as a result of *adding* evidence**, driving
   `recognised_share` down to 0.005. A reader comparing two runs would see the isolation
   table get dramatically "worse" after a pass whose only effect was to make the population
   visible. Denominator growth and numerator failure look identical in that field.

---

## Part 6 — What could not be measured, and what would make it measurable

| Unmeasured | Why | What would fix it |
|---|---|---|
| Which tier delivers the coverage | one aggregate report | separately-runnable tiers + `[[coverage.reports]]` with `tier =` per entry |
| Per-tier coverage; the pyramid's coverage denominator | same | same |
| `covered_but_unasserted` | `skipped:single_tier` | a tier declared `assert_weak` |
| Suite runtime, per tier | no duration channel | a per-tier timing artefact the engine ingests |
| True test counts | extent parser recovers 0.20–0.30 of declarations | engine-side lexical fallback (upstream BACKLOG TT-2); until then every count is a floor |
| Isolation for the 403 `createTestDb` callers | helper attribution over the import graph is outside `agent-vocabulary/1` | the contract's own named v2 candidate |
| Whether the 741 pure E5 files are really unit | `unit` is never positively evidenced | `[tests.tiers]` path declarations in `.codemetricsrc` |
| Coverage for `scripts/`, `packages/e2e`, non-JS files | no vitest project instruments them | out of scope for v8 coverage; the co-change proxy remains for those 453 files |

Two `open_questions` remain actionable and are **deliberately left open**:
`harness.e5_fallthrough` (no `harness` classification honestly fits a pure in-process test;
the fix is a declaration, not a token) and `isolation.unrecognised` (no honest token exists
for the 403 callers; inventing one would launder a conclusion into data).

---

## Appendix — reproducing this

```bash
# coverage (per package; ~28m total, server is ~23m of it)
cd packages/client     && pnpm exec vitest run --coverage --maxWorkers=3
cd packages/shared     && pnpm exec vitest run --coverage --maxWorkers=3
cd packages/mcp-server && pnpm exec vitest run --coverage --maxWorkers=3
cd packages/server     && VITEST_MAX_WORKERS=4 pnpm exec vitest run --coverage
pnpm coverage:merge

# analysis
code-metrics analyze . --output .code-metrics/run3 --coverage coverage/lcov.info
code-metrics query .code-metrics/run3/analysis.json --test-strategy
code-metrics query .code-metrics/run3/analysis.json --coverage
code-metrics query .code-metrics/run3/analysis.json --test-quality
```

Note `--minWorkers` is **not** a vitest 4.1.6 CLI flag (config-only); passing it aborts the
run with `CACError: Unknown option`. The per-package configs already set it.
