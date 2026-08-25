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
