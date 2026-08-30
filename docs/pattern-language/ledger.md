# pattern-language ledger — agentic-kanban

Loop state for the `pattern-language` skill (code-metrics-skill/pattern-language). A round not
logged here gets planned again. Convergence is always "at <sha> for <model>".

## Lanes (role-level map)
| Lane | Elements | Last mapped sha | Model | Notes |
|---|---|---|---|---|
| services | server-service (290) | 9aff91d30d | claude-fable-5 | 11 kinds; wiring axis measured (factory 58 / fn-module 107 / `= db` 24 / singleton 7 / global 4); rings R1–R5 |
| client | client-* (438) | 9aff91d30d | claude-fable-5 | 8 component kinds, 6 hook kinds, 8 lib sub-kinds; ring R8 (117 effect-fetch files); 24 type-only upward edges |
| startup/routes/repos/cli/lib/db | server-root/monitor/route/repository/cli/lib/db/middleware/scaffold/script | 9aff91d30d | claude-fable-5 | root vs monitor split; repository shape 106/113 `database = db` LAST; routes 44/44 `createRouter()`; rings R6/R7 |
| shared + mcp | shared-lib/schema/types, mcp-tool | 9aff91d30d | claude-fable-5 | shared-lib = 7 kinds (node-adapter 32, db-op 20, key-derivation 12, codec 14, stream-parser 15, pure 21, telemetry 2); mcp reach DBSING 27 / DEPS 39 / HTTP 28; rings R10–R12; drizzle-in-client leak |
| vocabulary + guards | cross-cutting | 9aff91d30d | claude-fable-5 | noun table (Soll×Ist×enforced), 10 collisions, guard-suite catalogue (5 shapes), 7 unmarked tree-guards, decision→element table |
| cross-cutting rings | cross-cutting | 9aff91d30d | claude-fable-5 | 10 candidates → 6 rings (R13 prefs, R14 now, R15 ak-N, R16 port/env, R17 errors, R7 wiring), 2 in repair (#529 sweeps 2/13, board-server-url 4/14), 2 not rings (events, logging) |

## Rounds
| # | date | model | HEAD | files | coverage | runtime violations | type-only cross-rule edges | rings | tickets |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-08-16 | claude-fable-5 | 9aff91d30d (started at 37172a4485) | 1303 | 100 % (path) | **5** (`service→monitor`; draft spec: 35 → 11 after type-erasure → 5 after root/scripts/lib fixes) | 24 (client DTOs) | 17 (+4 measured non-rings) | 35: #583–#617 |

Round-1 method: caller ran Step 0 (`vocab.py` histograms + `.dependency-cruiser.cjs` as Soll rules), drafted the spec, measured; 6 scout lanes (A services, B client, C startup/routes/repos, D shared+mcp, E vocabulary+guards, F cross-cutting rings) reported catalogue rows / candidates / verdicts / feedback; caller merged, judged the 35 draft violations, rewrote the spec (v2: `server-root`, `server-monitor`, `server-script`, `runtime-port`→lib, butler→service, `db→scaffold` allowed, mcp rules from depcruise, `lib/use*`→hook), saved `baseline.json`, filed. Skill v1→v2 changes folded in the same day (type-only erasure in the tool, seed-from-rule-file, collision table, composition-root/scripts default elements, `vocab.py`, ≥6-month ring caveat, `--diff-filter=A` dating, in-flight-unification tracking).

**Vocabulary baseline** (diff next round): file suffixes `.service` 169 · `.repository` 107 · `Panel` 39 · `View` 29 · `Section` 15 · `Store` 11; symbol suffixes View 62 · Service 59 · Panel 45 · Provider 31 · Gate 19 · Reconciler 14 · Cache 14 · Store 12 · Snapshot 12 · Lock 11 · Policy 10 · Port 8 · Registry 3; markers `@covers` 111 · `@gate:always-run` 23 (28 incl. shared); guard test suffixes `-guard` 15 · `-ratchet` 4 · `-parity` 3 · `-drift` 3 · `-boundary` 3.

**In-flight unifications to re-measure** (drain progress, not re-discovery): `lib/periodic-sweep.ts` (#529) 2/13 sweeps · `shared/lib/board-server-url.ts` 4/14 port ladders · `auth-rotation-ring.ts` 2/2 (done).

## Violation verdicts

### 2026-08-25 — #869: the two `shared-lib→shared-schema` runtime edges (claude-fable-5)
- **`packages/shared/src/index.ts → schema/index.ts` — BOUNDARY WRONG.** The package barrel's
  job is to union the three sub-barrels for 421 external importers; it classified as
  `shared-lib` only because that element's match hand-included `src/index.ts`, and the
  sub-kinds guard had already frozen it as "not really an exception". Removing `schema/` from
  the barrel would be a repo-wide consumer migration for no layering gain (the deep `./schema`
  path exists for callers that want it). Fix: new `shared-barrel` element (match
  `packages/shared/src/index\.ts$`, removed from `shared-lib`'s match) with rule
  `[shared-schema, shared-types, shared-db-op, shared-lib]`; `shared-barrel` added to the
  allow-list of every EXTERNAL consumer element that already allowed `shared-lib` (server-*,
  mcp-tool, client-*) — internal shared elements deliberately do NOT get it (importing your
  own facade is a cycle). Not a widening: the barrel was previously reachable as `shared-lib`
  by exactly those consumers, and `shared-lib` itself is now strictly schema-free with **no**
  exception.
- **`lib/dependency-type-traits.ts → schema/issue-dependencies.ts` — REAL, fixed by
  inversion.** The pure traits module value-imported the `DEPENDENCY_TYPES` vocabulary from
  beside the table. Per the #608 rule (a vocabulary read by non-persistence layers lives in
  pure lib), the vocabulary (`DependencyType`, `DEPENDENCY_TYPES`) now lives IN
  `lib/dependency-type-traits.ts`; `schema/issue-dependencies.ts` imports the TYPE back
  type-only (erased — no runtime edge) and keeps `DEPENDENCY_TYPE_LABELS`/
  `SYMMETRIC_DEPENDENCY_TYPES` typed by it. `schema/index.ts` no longer re-exports
  `DEPENDENCY_TYPES` (re-exporting a lib value through the schema barrel is the #618
  inversion); the two value consumers (`issue-dependency.service.ts`, a shared test) import
  the deep lib path the traits consumers already used. Shrank
  `shared-lib-sub-kinds.test.ts`'s `SCHEMA_READ_EXCEPTIONS` to the barrel-bookkeeping entry
  only; `packages/shared/CLAUDE.md` updated (no standing pure-module exception remains).
- Re-measured with `pattern_edges.py --scan --violations`: **rule violations 0** (was 2);
  `shared-barrel` allocates exactly 1 file, coverage still 100 %. `pnpm --filter
  @agentic-kanban/shared typecheck` clean.

### 2026-08-27 — #926: the 4 `server-monitor→server-root` edges (ak-926, claude-sonnet-5)
- **All 4 edges — BOUNDARY WRONG, same root cause.** `app-bootstrap.ts` (builds the Hono app +
  its cross-cutting middleware chain) and `boot-sequence.ts` (runs the sequential
  must-precede-serving boot phases) are both pure composition-root code — exactly the
  `server-root` "composition root" kind `packages/server/CLAUDE.md`'s #595 table already names
  (`route-setup`, `background-services`, `startup-tasks`, `readiness`, `process-handlers`,
  `scheduled-tasks`, `session-restore`, `fk-alignment`). Both were extracted from
  `server-start.ts` (their own header comments say so, `#873`) but were never added to
  `server-root`'s match regex, so they fell through to `server-monitor`'s directory-wide
  catch-all (`packages/server/src/startup/`) — first-match-wins, and the catch-all matched
  first because the specific list didn't include them. Their imports of `readiness.ts`,
  `startup-tasks.ts`, `service-stack-preflight.ts`, `session-restore.ts` (all four already
  `server-root`) are then flagged as `server-monitor` reaching sideways into `server-root`,
  when in reality it's `server-root` calling its own siblings.
- **Fix:** added `app-bootstrap|boot-sequence` to `server-root`'s match regex in
  `pattern-language.json`. No rule widened, no file moved — both files already live in
  `packages/server/src/startup/`, alongside every other composition-root file.
- Re-measured with `pattern_edges.py --scan --violations`: **rule violations 0** (was 4).
  `server-root` allocation 13 → 15 (+2 reclassified files), `server-monitor` 55 → 53,
  coverage still 100 %, no new violations introduced elsewhere.

### 2026-08-27 — #927: the 3 `server-monitor→server-middleware` edges (claude-sonnet-5)
- **All 3 edges (`app-bootstrap.ts` → `error-handler.ts`/`compress.ts`/`slow-request-logger.ts`)
  — BOUNDARY WRONG, same root cause.** `server-monitor`'s `match` is the whole
  `packages/server/src/startup/` directory (a catch-all), while `server-root`'s `match`
  enumerates specific composition-root files by name. `app-bootstrap.ts` builds the Hono app
  + its middleware chain — genuine boot-time wiring, extracted from `server-start.ts` (#873,
  its own docstring says so) — not monitor/sweep logic. It fell to `server-monitor` only
  because the catch-all matched before `server-root`'s explicit list caught up. Fix: added
  `app-bootstrap` to `server-root`'s enumerated list (`server-root` has no `rules` entry, i.e.
  unconstrained, so wiring middleware from there is fine).
- **Fallout, same fix**: reclassifying `app-bootstrap.ts` exposed a 4th, previously-hidden
  edge — `boot-sequence.ts` (also `server-monitor` by the same catch-all) → `session-restore
  .ts`/`startup-tasks.ts`/`service-stack-preflight.ts` (all `server-root`). Same shape exactly:
  `boot-sequence.ts`'s docstring says "extracted from `server-start.ts` (#873)" — the
  sequential must-precede-serving boot phase, imported only by `server-start.ts`. Also
  BOUNDARY WRONG; added to `server-root`'s list.
- Re-measured with `pattern_edges.py --scan --violations`: **rule violations 0** (was 3, briefly
  4 after the first fix exposed the hidden one). Coverage still 100%, no unassigned files.
- Not fixed as code moves: both files already sit in `packages/server/src/startup/` next to
  their sibling `server-root` files (`route-setup.ts`, `background-services.ts`, …), so this is
  purely a spec `match` gap, not a misplaced file.
- **Overlap note**: #926 (merged first) already reclassified `app-bootstrap.ts`/
  `boot-sequence.ts` as `server-root` and added them to the enumerated list for the
  `server-monitor→server-root` edges it found. This round's fix to `pattern-language.json` is
  the same enumerated-list addition; the middleware edges above are the ones #926 did not
  need to touch (it only measured the `→server-root` edges, not `→server-middleware`).

### 2026-08-29 — #942: the 1 `server-route→server-monitor` edge (ak-942, claude-opus-5)
- **`routes/board-monitor.ts → startup/monitor-start-scoring.ts` — REAL, fixed by moving the
  code.** The route imported `previewNextStartCandidates`, the read-only backing function of
  `GET /api/projects/:id/board-monitor/next`. It is not monitor-engine code and never was: it
  persists nothing, launches nothing, and runs on no cycle — its own header called it "no
  persistence, no launch". It sat in `startup/` only because #917 split it out of
  `monitor-auto-start.ts` in the same commit as `orderCandidatesByStartScore`, the loop half
  that *does* persist. Fix: `previewNextStartCandidates` + `StartScorePreviewRow` moved to
  **`services/start-score-preview.service.ts`** (a `server-service`, which `server-route` already
  allows); `monitor-start-scoring.ts` keeps only the loop half.
- **Second move the first one forced — `startup/monitor-eligibility.ts` was MISPLACED.** The
  preview needs `monitorEligibleIssueSql` / `notDriveOrEpicMetaSql` / `resolveCandidateStatusIds`,
  so a naive move would have re-created the same edge one layer down as
  `server-service→server-monitor`. Two candidate homes were ruled out by rules already in force:
  `services/` cannot hold it (`services-bypass-repositories` is a **total error** gate and the
  module value-imports `drizzle-orm`), and a standalone `*.repository.ts` cannot either
  (`server-repository` has no `server-repository` in its allow-list, so its call to
  `findProjectStatusIdByName` would be a fresh violation). It therefore merged INTO
  **`repositories/start-scoring.repository.ts`** — the same use-case slice (start-candidate
  selection), which already owned the query these fragments filter and already exported the
  status lookup, making that call internal rather than a cross-repository edge. The module is
  two drizzle SQL fragments, one pure predicate over an issue row, and one status-id lookup;
  nothing about it was the monitor engine.
- **Not a rule widening.** `pattern-language.json` is UNCHANGED — no `match` edit, no `rules`
  edit. Both fixes are code moves, which is the verdict the brief asks for when the file
  behaves like another element.
- **Bonus drain, disclosed:** `startup/`'s raw-persistence backlog drops 30 → 29. The
  `DRIZZLE_BASELINE` entry in `startup-persistence-boundary-ratchet.test.ts` is REMOVED (not
  kept) and `.dependency-cruiser.cjs`'s stated `Backlog:` count lowered to match — that suite
  fails on a baseline outliving its offender, and separately asserts the declared count against
  what is on disk.
- Re-measured with `pattern_edges.py --spec … --scan . --violations`: **rule violations 0**
  (was 1), no new pair introduced, coverage still 100% / 0 unassigned. `pnpm check:arch`
  0 errors, `pnpm typecheck` clean, `pnpm test:mine -- --changed HEAD` 92 files / 840 tests
  green (incl. the always-run guard suites).

### 2026-08-29 — #946: the 1 `server-lib→server-service` edge (ak-946, claude-opus-5)
- **`packages/server/src/lib/review-mode-pref.ts → services/risk-posture.service.ts` — REAL,
  fixed by relocating the file into the element it behaves like.** `server-lib`'s intent is
  "pure server-side compute … imports no services"; this module's whole job is
  `resolveProjectReviewMode`, which fans the risk-posture dial out into a review decision
  (#937, decision 017) and therefore *must* call `resolveRiskPosture`. A lib file that cannot
  do its job without a service is not a lib.
- **Why relocate rather than split `risk-posture.service.ts`.** The tempting alternative —
  move the pure half of the posture resolver down into `lib/` — is architecturally attractive
  but touches ~12 importer files and would collide with the parallel arch tickets sharing this
  round. The decisive argument is convention, not cost: `merge-train-window.ts`,
  `pre-merge-gate-tier.ts`, `placement-evaluators.ts` and `merge-queue-train.ts` are the SAME
  shape (a prefMap resolver over `resolveRiskPosture`) and all four already live in
  `services/`. `review-mode-pref.ts` was the lone outlier, so moving it makes the population
  uniform instead of adding a second home for one kind.
- **Purity is unchanged.** `resolveProjectReviewMode(prefMap, projectId)` is still sync and
  touches no DB — `prefmap-resolver-purity.test.ts` checks the FUNCTION, not the file, and
  keeps enforcing that in its new location (services/ is where most prefMap resolvers already
  are). The move costs no testability.
- **Not a rule widening.** `pattern-language.json` is UNCHANGED — no `match` edit, no `rules`
  edit. `server-lib` allocation 57 → 56, `server-service` 380 → 381. Callers updated:
  `startup/exit-workflow.ts`, `startup/exit/review-launch.ts`,
  `startup/stranded-review-reconciler.ts`, `__tests__/risk-posture-fanout.test.ts`, plus the
  stale path references in `docs/decisions/017-risk-posture.md` and
  `shared/lib/dynamic-preference-keys.ts`.
- Re-measured with `pattern_edges.py --spec … --scan . --violations`: this pair **0** (was 1),
  no new pair introduced, coverage still 100% / 0 unassigned. The two remaining violations
  (`server-route→server-monitor`, `server-service→server-monitor`, both into
  `startup/base-branch-health-reconciler.ts`) are OTHER units and deliberately untouched.
### 2026-08-29 — #947: the 1 `server-route→server-monitor` edge (ak-947, claude-opus-5)
- **`routes/project-health.ts → startup/base-branch-health-reconciler.ts` — REAL, fixed by
  relocation.** The imported symbol was `requestBaseBranchReprobe`, the on-demand "probe the
  base again if it makes sense" door. That function is not a sweep: it is a decision
  (`isBaseHealthProbeDue`) plus one orchestration call, and its two callers are a route and
  `services/workspace-merge-gate.ts` — neither of which may import `startup/`. The file it sat
  in genuinely IS a `server-monitor` (a timer registered in `BACKGROUND_SERVICES`), so the
  boundary was right and the placement was wrong.
- **The gate's dynamic `import()` was the same defect from the other side**, and is the reason
  this was not a rule-widening candidate. `workspace-merge-gate.ts` reached the same function
  through `void import("../startup/…")` with a comment stating outright that `services/` must
  not import `startup/` statically (#595) — i.e. the layering rule was already being
  acknowledged and routed around rather than satisfied. Widening `server-route`'s allow-list to
  include `server-monitor` would have blessed both.
- **Fix:** `isBaseHealthProbeDue`, `requestBaseBranchReprobe` and the shared
  `resolveBaseHealthProbeDue` (which de-duplicates the six-line "read latest row + probe stamp +
  decide" block the sweep and the door each had) moved to
  `services/base-branch-health-reprobe.service.ts`. The reconciler shrank to the sweep alone
  (245 → 100 lines) and now imports DOWN into that service, the direction the spec already
  allows (`server-monitor → server-service`). The route's import became a normal
  `server-route → server-service` edge. The gate's `import()` stayed dynamic — the layering
  reason is gone, but it is on the merge gate's hot path and the door is reached only on a
  non-answer base row, so the deferred load is now a cost decision rather than a rule dodge;
  the comment says so.
- **No spec change.** `rules` and every element's `match` are untouched — the code moved to
  where its behaviour already belonged.
- Both `startup-persistence-boundary-ratchet.test.ts` baselines still hold: the reconciler keeps
  its `db` value-import and its direct `projectsTable` select, so neither entry went stale.
- Re-measured with `pattern_edges.py --spec … --scan . --violations`: the pair reports **0**,
  coverage still 100% / 0 unassigned, no new pair introduced. One PRE-EXISTING violation remains
  repo-wide and is untouched by this diff — `server-lib→server-service`
  (`lib/review-mode-pref.ts → services/risk-posture.service.ts`), a separate loop unit.
  `pnpm check:arch` 0 errors (30 pre-existing `startup-bypasses-repositories` warnings),
  `pnpm typecheck` clean, and the 7 affected suites (reprobe guard, base-health
  concurrency/recency, merge-gate red-base attribution, background-sweep registry,
  startup-persistence ratchet, sweep-timer mechanism) 43/43 green.

## Filed (exclusion list — same idea ⇒ reference, don't refile)
| # | verb | title |
|---|---|---|
| #583 | name | name `guard suite` — declarative `@guard:<kind>` marker + shared walk/ratchet helpers |
| #584 | name | name `background sweep` (reconciler/reaper/scanner) — one placement + registry-completeness test |
| #585 | name | name `decision function` (decide*/classify*/should*) — doc row + purity guard |
| #586 | name | name `prefMap resolver` — pure `resolveX(prefMap, ctx)` + purity scanner (6 members) |
| #587 | name | name + unify `coded-domain-error` — one `DomainErrorCode` union, retire the frozen `AppError` ring |
| #588 | name | name `overlay-panel` — `PANEL_REGISTRY` like `VIEW_REGISTRY` (18 hand-wired show/onClose pairs) |
| #589 | name | name client `pure-core-beside-component` + `query-options module` — doc rows, relocate the strays |
| #590 | name | name `shared-db-op` and split `shared-lib` in the spec — only db-ops may reach `shared/schema` |
| #591 | name | name `exec-adapter` — one `ExecResult`, `<system>-exec.ts` rule (git null vs docker/devcontainer -1) |
| #592 | name | name `report-returning pass` — one `PassReport` shape for run*/sweep*/reap*/reconcile* (43 members) |
| #593 | name | name `provider-pair` — per-provider adapter files behind `agent-provider/` (rate-limit/login pairs; copilot/pi missing) |
| #594 | enforce | enforce service ⇏ monitor/startup — relocate 3 utilities + extract wip-capacity (5 runtime violations → 0) |
| #595 | enforce | enforce layering for `startup/` — split root vs monitor engine, depcruise rule with backlog |
| #596 | enforce | enforce transitive client-safety of shared deep imports — drizzle + schema are in the browser bundle today |
| #597 | enforce | enforce `windowsHide: true` on every Node spawn — allowlist scanner (CLAUDE.md hard constraint, no guard) |
| #598 | enforce | enforce the git/worktree invariants CLAUDE.md states — 5 cheap scanners + 3 parity tests |
| #599 | enforce | enforce decision 005 on the READ side — ratchet raw `=== "Done"/"Cancelled"` comparisons (13 prod files) |
| #600 | enforce | enforce decision 008 — every auto-start path calls `resolveStartPolicy` (allowlist scanner) |
| #601 | enforce | enforce that the guard mechanism reaches the CLIENT — add `packages/client` to test-mine + 3 client scanners |
| #602 | enforce | enforce `check:arch` green + in the always-run set — `pnpm lint:arch` is red on master, 'Backlog: 0' comments stale |
| #603 | unify | unify client data fetching (ring R8) — co-occurrence ratchet `useEffect`+`apiFetch` DOWN-only, react-query is the endorsed layer |
| #604 | unify | unify service wiring (ring R1/R2) — document fn-module vs factory, ratchet out singletons/direct `db`, retire `Ops` |
| #605 | unify | unify MCP board-reach — migrate the 27 `db`-singleton tools to the DEPS seam; allowlist in-memory state → HTTP |
| #606 | unify | unify read-model routes (ring R6) — 5 repository-backed routes → `lib/` projections; fold `monitor-setup` internal routes into `routes/` |
| #607 | unify | unify shared-lib exposure (ring R11) — `"./lib/*"` export pattern, one import spelling |
| #608 | unify | unify column-vocabulary home (ring R12) — `as const` next to the table is the rule; `sessions.status` gets a union |
| #609 | unify | unify reconciler timers — allowlist scanner: no raw `setInterval` in `startup/*-(reconciler|reaper|scanner).ts` (extends #529) |
| #610 | relocate | relocate client DTO types out of components/routes — 24 type-only upward edges, `Project` ×3, `WorkspaceInitial` drift |
| #611 | fold | fold vocabulary collisions — rename the minority senses of gate / port / view / scanner / provider (collision table in the map) |
| #612 | fold | fold one-offs into their elements — `wrapAiOperation`, 7 `.service.ts` shims, `types/service-stack` codec, `Toast.tsx` re-export, non-coded errors |
| #613 | unify | unify preference reading (ring R13) — delete 8 clone readers, ratchet raw `schema.preferences` + inline keys that have a helper |
| #614 | unify | unify `now` injection (ring R14) — one spelling rule + ratchet raw `Date.now()` in staleness/expiry code (CLAUDE.md rule unenforced) |
| #615 | unify | unify server-port ladder + env naming (ring R16) — drain to `resolveBoardServerPort` (10 sites), `KANBAN_*` rule + env registry |
| #616 | name | name `tagged console log` — the `[tag]` convention (791 tagged / 44 untagged, 121 tags) gets a doc row; fold the one `logger.warn` |
| #617 | unify | unify MCP error text + result-object spelling (ring R17) — 36 inline `text: Error:` literals + 7 `text()` clones → `mcpError`; `ok` vs `success` |

Cross-references to `refactoring-scout` tickets (siblings, not refiled): #496 `projectPref()` (↔ #613 prefs ring), #499 CLI wrappers (↔ ring R7 CLI data access — fold the placement sentence into #499), #529 `startPeriodicSweep` (↔ #609), #531 service-stack codec (↔ #612), #533 `XDb` alias (↔ #590), #548 `parseIssueNumberFromBranch` (↔ ring R15 — sibling evidence: 6 regexes in `git-service/worktree.ts:51`, `worktree-ports.ts:28`, `hand-merged-branch-reconciler.ts:21`, mcp `session-history.ts:44`, cli `system.ts:242`), #566/#567/#570 DTO/vocab SSOT (↔ #610, #608), #503 provider fan-out (↔ #593).

## Sibling evidence (extra file:line for an existing ticket)
- #548 (branch parsing): the six `ak-<N>` regexes listed above; 4 `slugify` clones (`butler-definitions.service.ts:45`, `phase-artifacts.service.ts:33`, `scripts/mock-agent.ts:411`, `client/lib/projectSlug.ts:30`).
- #499 (CLI): ring R7 — 17 command files use repositories, 11 services, 9 `fetch()`; `tag.ts:32` vs `issue.ts` for the same role.

## Rejected (reason-scoped)
- "board event emission is a ring" — measured NOT: one `createBoardEvents()` hub built in `server-start.ts:103`, DI'd into 19 routes/32 services/16 startup files, 0 singleton imports; the narrowed `broadcast` callback (10 files) is dependency-narrowing. Coarse `board_changed` vs typed events = a doc row, not a ring.
- "hooks returning JSX explain `hook→component` ×16" — refuted, 0 render-hooks; all 16 are `import type` of DTOs (→ #610).
- "`server-db→server-scaffold` is a violation" — `seed.ts` seeding built-in skill CONTENT is db bootstrap; allowed in spec v2.
- "reconciler injection style (`deps` vs `database = db`) is a ring" — legit: `deps` only where a sweep launches agents.
- "MCP DB-vs-HTTP reach is a ring" — documented heterogeneity (`docs/domain/mcp-server.md`); the DBSING-vs-DEPS half IS a ring (→ #605).
- "validation zod-vs-hand per layer is a ring" — technology difference between MCP SDK and Hono; only the intra-route `parseJsonBody` vs raw `c.req.json()` (3 files) is a fold.
- "annual rings by era" — repo is ~3.5 months old; every style spans the whole history → reported as co-existing styles.
