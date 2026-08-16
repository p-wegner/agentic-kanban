# agentic-kanban — pattern language (Mustersprache) map

Round 1 · 2026-08-16 · HEAD `9aff91d30d` · model claude-fable-5 · produced with the
`pattern-language` skill (`code-metrics-skill/pattern-language`, tools `pattern_edges.py` +
`vocab.py`). Lilienthal's frame: a pattern language = a set of **kinds of building blocks**
(Musterelemente: role, characteristic interface, placement/naming) + **rules** for which kind may
use which. This map records what the code *actually* follows (explicit or implicit), where it is
inconsistent (violations, *annual rings* = one role in several home-grown styles), and what is
worth making explicit. Ledger/freshness: `ledger.md`. Spec: `pattern-language.json`.
Baseline: `baseline.json`.

## Summary numbers

| | value |
|---|---|
| production source files in scope | 1303 (server 604 · client 438 · shared 165 · mcp 95) |
| path-level allocation | 100 % into 21 elements (proxy — see role level) |
| **runtime rule violations** | **5** (all `server-service → server-monitor`; the draft's 35 shrank to 11 after erasing type-only imports, to 5 after the spec learned root/scripts/lib boundaries) |
| type-only cross-rule edges | 24 (client DTOs declared in components/routes, imported by hooks/lib — a *placement* smell, one relocate ticket) |
| existing machine-checked rules | `.dependency-cruiser.cjs` — 14 rules, error severity, `check:arch` (currently **red on master**: 2 `→ shared/schema` edges from `routes/focus.ts`, `cli/commands/issue-dependency.ts`) |
| what depcruise does NOT cover | `startup/` (monitor engine + sweeps: 30/54 files import drizzle directly), `lib/`, `worker/`, `scripts/`, the whole client for the always-run guard set |
| role-level elements found | 38 sub-elements across the 8 big buckets (below); 12 implicit-pattern `name` candidates; **17 annual rings** (+4 measured non-rings); 10 vocabulary collisions |
| Musterkonsistenz verdict | explicit core language exists and is *guarded* (service, repository, route, gate, reconciler, provider, hook, registry, guard suite) — but ~half of it is unnamed in docs, `startup/` is a role bucket that evades the layering, and data-access/wiring styles are rings in every package |

## Vocabulary — Soll (docs) vs Ist (code)

`vocab.py` + lane E. **Explicit core** (documented + carried + tested): service, provider, hook,
gate, conductor, workflow, policy, reconciler, monitor, butler, sweep, registry(code-named).
**Documented but not carried in code** (implicit elements): *adapter / seam / port(hexagonal)* —
three words for ONE thing (the git-exec adapter); *guard / ratchet / parity / scanner* — one thing
(the guard suite) under four words; SSOT. **Carried but undocumented**: repository (107 files, 1
doc mention!), reaper, `start/stopX` background pair (25 exports), resolver shape, projection
(decision-only), snapshot/cache/lock, client View/Panel/Section.

**Collisions (one word, ≥2 senses — pattern-language defects):**

| noun | senses |
|---|---|
| provider | agent provider (`AgentProvider`, 4 impls) · quota provider · strategy `Provider` union · React context providers (4) |
| port | TCP port (20/21 `*Port*` symbols, `runtime-port.ts`) · hexagonal port (`OrphanedWorktreeGitPort`, CLAUDE.md "adapter/port") |
| gate | pre-merge verify gate · plugin human gate (`PluginLoopGate`, `GateCard`) · file-contention gate · readiness gate · JVM build **semaphore** (`jvm-build-gate.ts:37`) · `@gate:always-run` test marker |
| hook | `.claude/hooks/*.js` scripts (17) · React hooks (58) · git hooks |
| monitor | Autopilot / Steward / Conductor (CLAUDE.md's own three) · `LoopLagMonitor` · `orchestrator-monitor.service` |
| service | server service module (290) · Docker service stack (14 files, decision 011) · "the shared git service" |
| view | board view (27 in `VIEW_REGISTRY`) · presentational half of a container pair (`XView`, 6, since 2026-07-18) · `status-view` (shared) |
| contract | interface contract · the coupling-*contract* op (decision 010, 14 symbols) |
| scanner | guard-suite scanner (tests) · `done-unmerged-invariant-scanner.ts` (a runtime reconciler) |
| engine / workflow | workflow engine · plugin-loop engine · services engine · "in-process engine"; workflow graph · `exit-workflow`/`merge-workflow` · `kanban-workflow` skill |

## Element catalogue (role level)

Confidence: **explicit** = documented AND enforced by a test/lint · **documented** = named in docs,
unenforced · **implicit** = consistent shape, unnamed · **emerging** = 2–4 members.

### Server — `services/` (290 files) → 11 kinds (lane A)
| element | role · characteristic interface | recognition | n | confidence |
|---|---|---|---|---|
| **factory-service** | stateful/orchestrating capability, deps injected once: `createXService(deps: {database,…}) → { fnA, fnB }` (object of closures) | `^export function create\w+(Service\|Ops\|Engine\|Runtime\|Registry\|Manager\|Lifecycle\|Cache)\(` | 58 files / 63 factories | documented (`packages/server/CLAUDE.md` DI-via-factory) + explicit for the negative half (`no-self-http-in-services`) |
| **fn-module service** | same role, stateless: `export async function doX(id, database: Database)` | export with `\b(database\|db)\??: Database\b`, no factory | 107 | implicit — `.service.ts` suffix on only ~59 % of the lane |
| **resolver** | prefs/env/context → one decision: (a) pure `resolveX(prefMap, ctx)` (`start-policy.service.ts:70`, `effective-config.service.ts:54`, `provider-config-resolution.ts:57`, `project-runtime-config.service.ts:94`, `agent-settings.service.ts:76`, `conductor-schedule.service.ts:71`) (b) async db-reading `resolveX(id, database)` | `^export (async )?function resolve[A-Z]` | 37 (≈8 pure prefMap, ≈10 db, rest path/port) | explicit for provider (`provider-resolution-single-source`), documented for start policy (008), implicit otherwise |
| **gate** | decision + evidence before an irreversible step: `runXGate(args, deps) → {passed, skipped, stage, message}` (`pre-merge-gate.service.ts:249`, `workspace-merge-gate.ts:142`) | `Gate\b` in file / `run\w*Gate\(` | 6 (+2 monitor) | documented (CLAUDE.md pre-merge gate) — overloaded, see collisions |
| **reconciler / sweep / preflight (report-returning pass)** | detect DB↔world drift, repair, return a report: `reconcileX(input, deps)`, `runXPreflight(id, db)`, `sweepX(…, {repair})` | `^export (async )?function (run\|sweep\|reap\|reconcile)[A-Z]` | 24 in services + 19 in `startup/` | documented vocabulary; boundary is *who schedules it*, not role (ring R5) |
| **adapter / port** | wrap ONE external system: explicit ports `AgentProvider` (4 impls), `ComposeRunner`, `QuotaUsageProvider`, `VersionRunner`, `WebhookSender`; implicit `process-exec.ts` (15 fns), git via shared adapter | `implements \w+(Provider\|Runner)` / `^export interface \w+(Runner\|Provider\|Sender)` | 5 explicit; ≈74 technology-kind files | explicit for git (`git-exec-single-spawn`), implicit for process/docker/fs (19 files spawn beside `process-exec.ts`) |
| **coded-domain-error** | `class XError extends Error { code: "NOT_FOUND"\|… }` mapped once in `middleware/error-handler.ts:10-30` | `^export class \w+Error extends Error` | 15 classes, ≈330 throws | documented+structural — but ring R3 |
| **projection / snapshot / summary** | read-only aggregate for a view, never writes: `buildX(rows) → Summary`, `computeX(db, id, window)` | name regex `projection\|snapshot\|summary\|dashboard\|analytics\|scorecard\|timeline\|insights\|digest` | 19 (+2 in `lib/`) | implicit (decision 014 names one) |
| **cache / lock / claim** | in-process memo or mutual exclusion (`board-etag-cache`, `workspace-summary-cache`, `agent-questions/cache.ts:25`, `workspace-internals.ts:627 activeMerges`, `auto-start-claim`, `port-allocator`, `jvm-build-gate`) | `*-cache*\|*-claim\|*-lock` | ≈10 | implicit; 2 wiring styles |
| **registry** | name→instance: `agent-provider/registry.ts` (module Map + accessor) · `butler-sdk/registry.ts:13` (exported bare Map) · `createWorkerRegistry(db)` (factory) | `registry` in path | 3 (3 shapes) | emerging, inconsistent |
| **re-export shim / types-only** | 7 compat shims still named `*.service.ts` (`git.service.ts`, `session.manager.ts`, `setup-script.ts`, `agent-provider.ts`…) + 8 type modules | only `export … from` / `export type` | 15 | decomposition residue |

Wiring facts (measured): required-param DB injection ≈130 files · `database: Database = db` default 24 · module singleton `export const xService = createXService({database: db})` 7 (all created ≤2026-07-14, still consumed: `routes/butler.ts:22`) · direct global `db` w/o param 4. Same service wired both ways: `preferenceService` singleton in `routes/butler.ts` vs `createPreferenceService({database})` in `routes/config-export-import.ts:101`. **No class-based services exist** (25 `export class` = 18 errors, 5 port impls, 2 misc). Technology-kind files ≈26 % of the bucket; worst mixed: `project.service.ts` (995 LOC, 5 repos + spawn + docker + git), `workspace-internals.ts` (879: error class + lock + resolver + git).

### Server — `startup/`, routes, repositories, cli, lib, db (lane C)
| element | role · interface | recognition | n | confidence |
|---|---|---|---|---|
| **composition root** | boot: migrations, startup tasks, route mount, background-service registry, process handlers, readiness — `setupRoutes(app, deps)`, `BACKGROUND_SERVICES[]` (`startup/background-services.ts:62`, order = start order) | the 13 files now in spec element `server-root` | 13 | documented (`packages/server/CLAUDE.md:15`) — the ONLY part of `startup/` that runs at boot |
| **monitor engine** (Autopilot) | per-cycle candidate walk / auto-start / backlog / contract / file-contention gate / exit + merge workflow: `runX(prefMap, deps)`, `createWorkflowEngine(deps)`, `createAutoMerge(deps)` | `startup/(monitor-\|exit-workflow\|merge-workflow\|auto-merge)` | 17 (~5.5 k LOC) | documented (CLAUDE.md, decisions 006/008) — **misplaced**: lives under `startup/`, runs every cycle; **28/54 startup files import the `db` singleton, 30/54 import `drizzle-orm`** — outside every depcruise rule |
| **background sweep** (reconciler / reaper / scanner) | crash-safe periodic pass: `reconcileX(deps\|db, now?) → Report` + `startX(deps, intervalMs)`/`stopX()` module-singleton timer pair, registered by name in `BACKGROUND_SERVICES` | `startup/*-(reconciler\|reaper\|scanner\|sweep)\.ts` | 13 timer pairs + 6 one-shot in startup, +3 living in `services/` (`session-message-pruner`, `monitor-butler`, `project-conductor`) | implicit — registry exists, no doc names the kind, placement split |
| **decision function** | pure sync verdict co-located with its executor: `decideX(row) → {action, reason}` / `classifyX` / `shouldX` — `born-blocked-reconciler.ts:86`, `orphaned-worktree-reconciler.ts:74`, `session-exit-classification.ts:66`, `rate-limit-exit-decision.ts:61`, `monitor-cycle-rules.ts:80`, `monitor-file-contention.ts:183` | `^export function (decide\|classify\|should)[A-Z]` | ≥12 in startup | implicit |
| **repository (function module)** | pure drizzle access per *use-case slice* (not per table): `export async function verbNoun(args…, database: Database = db)` — db LAST with singleton default (106/113 files; 116 sigs LAST, 0 FIRST); god-module splits `repositories/session/*`, `repositories/issue/*` behind facade barrels | `repositories/.*\.ts$` | 113 | **explicit** (`repositories-are-infra-pure`, `repositories-not-up-to-services`, god-module gate `scripts/check-god-modules.mjs`, `repository-table-ownership` ratchet) |
| **route factory** | thin Hono adapter: `createXRoute(database, opts?) { const router = createRouter(); const svc = createXService({database}); … }` — 44/44 use `createRouter()`, 0 zod, 28 `parseJsonBody`, 3 raw `c.req.json()`; route→db ×41 = all `import type { Database }` | `routes/.*\.ts$` | 45 | explicit (`routes-not-down-to-persistence`) — ring A |
| **projection / pure formatter** (`lib/`) | pure compute "extracted so it is unit-testable without a server": `computeX(rows, days, now)`, `buildXLines`, `mapXRow`; 46/47 lib files import no `node:`/db, 0 import services | `lib/*.ts` pure | ≈30 of 40 | implicit (self-described in headers) |
| **process-local infra singleton** (`lib/`) | node-side module state + `startX/stopX/resetXForTest` (`exit-record.ts:186`, `loop-lag-monitor.ts:76`, `monitor-spawn-control.ts:365`, `periodic-sweep.ts:53`) | | 5 | implicit |
| **CLI command registrar** | `registerXCommand(program)`; `.action` = `runMigrations()` + try/catch + `process.exit` | `cli/commands/*.ts` | 22 (17 call repos, 11 services, **9 `fetch()` the live server**) | explicit shape (`cli-not-down-to-persistence`); data-access style is ring B |
| **middleware** | `createRouter()`, `domainErrorHandler`, `parseJsonBody<T>`, gzip, slow-request sampler | `middleware/` | 6 (`ai-operation.ts wrapAiOperation` is a service wrapper → fold) | implicit |
| **db bootstrap** / **scaffold artefact** | migrations/pragmas/backup/repair/seed · JS + skill content SHIPPED into other repos (`scaffold/*.js`, `BUILTIN_SKILLS`) | `db/` · `scaffold/`, `builtin-skills*` | 11 · 7 | documented (`db-doctor`, CLAUDE.md built-in skills) |
| **script / entrypoint** | one-shot executables under `src/scripts/` — unconstrained downward | `scripts/` | 7 | (spec fix: were "lib", manufactured 2 violations) |

### Shared — `lib/` (118) → 7 kinds, schema, types (lane D)
| element | role · interface | recognition | n | confidence |
|---|---|---|---|---|
| **node-adapter** | port to one external system (git/docker/devcontainer/fs/child_process): `xExec(args, opts) → {stdout,stderr,code,error}` + `xAvailable()`; **deep-path only**, never a VALUE export in the client barrel | file value-imports `node:*` | 32 (`git-exec.ts` 547 LOC, `git-service/*` 10 behind facade, `docker-exec.ts:44`, `devcontainer-exec.ts:74`, `repo-lock`, `temp-dir`, `ticket-context`…) | **explicit** for the exposure rule (`barrel-client-safety`, always-run) + git (`git-exec-single-spawn`); implicit as a named kind. Ring: `code: number\|null` (git) vs `number` with -1 (docker/devcontainer) |
| **shared-db-op** ("shared repository": drizzle op used by BOTH server and mcp because `mcp-no-server-internals` forbids importing server) | one write/cascade authority for a domain fact: `async fn(db: XDb, …, {now?})`, local `XDb` alias | value-imports `drizzle-orm` | 20 (`cascade-delete`, `checked-preference-write`, `workflow-engine/status-transition.ts` "#953 single write authority", `workspace-status.ts:196 setWorkspaceStatus`, `issue-number`, `fk-actions*`, 9 `workflow-engine/*`) | implicit — docs call each an SSOT, never the kind; guarded piecemeal (`issue-number-single-source`, `status-write-ratchet`). **All 16 `shared-lib→shared-schema` edges are this kind** — the rule should say only shared-db-op may touch schema |
| **key-derivation** | make a stringly key exactly once: `xPrefKey(projectId)`, `isXKey`, `parseX`, `X_KEY` + `isXEnabled(prefMap)` | exports `*_PREF_KEY\|*PrefKey\|KEY_PREFIXES` | 12 (`auto-merge-pref`, `dynamic-preference-keys.ts:18`, `plugin-keys.ts:73`, `strategy-policy.ts:139`, `repo-tags`, `branch`) | implicit (#496 `projectPref()` filed for the dup) |
| **contract-codec** | published wire/manifest contract: `interface X` + `parseX(raw: unknown) → X\|null` or zod schema | exports zod schema / `parse*Message\|Manifest\|State` | 14 (`plugin-manifest.ts` 787 LOC, `worker-protocol.ts:95`, `mcp-tool-definitions`, `settings-registry`, `agent-stream/claude-schema`) | implicit; per-contract parity guards exist (`mcp-catalog-parity`, `copilot-event-types-lockstep`, `agent-stream-field-drift`, `strategy-policy-parser-parity`) |
| **stream-parser** | per-provider agent-CLI event → display event: `parse<Provider>Event(obj, ctx)` (`agent-stream/claude.ts:277`, `codex.ts:200`, `copilot.ts:104`, `pi.ts:210`) behind facade `agent-stream-parser.ts` | `parse\w+Event` | 15 | implicit-consistent (4/4 same signature) |
| **pure-policy / projection** | decision or view from inputs, no I/O: `classifyX`, `computeX`, `checkXTransition`, `deriveX` (`status-view`, `status-transitions.ts:61-191`, `workspace-activity-state`, `coupling-overlap`, `dependency-graph`, `verify-command`, `workflow-engine/conditions`) | no node/drizzle value import | 21 | implicit |
| **telemetry-singleton** | process-wide counters + `resetXForTest` (`operation-metrics.ts:177`, `operation-windows.ts:197`; seams in `git-exec.ts:315`, `unknown-events.ts:67`) | `ForTest\(` | 2 (+3 seams) | emerging |
| **facade-over-subdir** | `git-service.ts`, `workflow-engine.ts`, `agent-stream-parser.ts` — header rule "sub-modules import each other directly, never this barrel" (measured 0 breaches) | | 3 | implicit (prose only) |
| **schema table module** | `sqliteTable` + `xRelations` per file, kebab plural files, camel plural tables; 26/32 one table, 6 aggregates (legit) | `schema/` | 33 | explicit (`migration-schema-drift`); column vocabularies live in **4 places** (ring c) |
| **type-only DTO** | `export type *` barrels | `types/` | 14 — odd member `types/service-stack.ts:69-114` runtime codec (→ fold to lib, overlaps #531) | explicit (barrel type-only) |

### MCP server (95) (lane D)
One uniform registration shape — `server.tool(name, description, zodShape, handler)` ×103 in 87
files, `TOOL_REGISTRARS` map (`index.ts:109-212`), catalog `MCP_TOOL_DEFINITIONS` 103 entries,
**parity guard** `mcp-catalog-parity` (explicit, always-run, in `check:arch`). Three
**board-reach styles** coexist (ring a): DBSING (module `db` singleton) 27 files, DEPS (`register(server,
deps = prodDeps)` DI seam, endorsed by `docs/domain/mcp-server.md:112`) 39, HTTP (proxy to REST) 28
— all 5 tools added after 2026-07 are HTTP-only. DB-vs-HTTP is documented heterogeneity
("state that lives in server memory must be delegated") but convention-only.

### Client (lane B)
| element | role · interface | recognition | n | confidence |
|---|---|---|---|---|
| **board-view** | top-level board mode in `VIEW_REGISTRY` (`lib/viewRegistry.tsx:244`, 27 ids), switched by URL segment, often `lazy()` | `*View.tsx` AND registry id | 27/26 | explicit for the registry (+ `viewTabs` collision test), naming implicit |
| **overlay-panel** | modal/side overlay with `onClose`, mounted in `BoardOverlayPanels.tsx` from `useBoardPanels()` booleans — **18 wired by hand** as `showX`/`onCloseX` pairs (`hooks/useBoardPanels.ts:5-44`) | `*Panel.tsx` + `onClose` | 39 (22 with onClose) | implicit (no registry — unlike board-view) |
| **modal / dialog** | confirm/edit overlays | `*Modal\|*Dialog.tsx` | 10 | implicit |
| **detail-section** | one sub-block of issue detail / settings / workflow panel, no fetching | `*Section.tsx`, `settings/*` (the ONLY sub-dir in 244 components) | 15 + 19 | implicit |
| **container/presentational pair** | `X` fetches, `XView` is "data in, markup out", same file (`RepoMergeStatusStrip.tsx:83/174`, `FleetServiceStackMap.tsx:171`, `MultirepoHealthPill.tsx:15`) | file exports both `X` and `XView` | 6, since 2026-07-18 | emerging — collides with board-view's `View` |
| **primitive** | props-only UI atom (`Button`, `Badge`, `SplitButton`, `CollapsibleSection`, `SettingsPrimitives`) | no projectId/api/store/ws | ≈12 | documented (SplitButton row in `packages/client/CLAUDE.md`) |
| **badge / strip / chip** | small live status indicator, often WS-driven | suffix | ≈9 | implicit |
| **query-hook** | `useXQuery(projectId): UseQueryResult`, keys from `lib/boardQueryKeys.ts` — the ONLY `useQuery(` site is `useBoardDataQueries.ts` (11 hooks) | | 5 files / 12 hooks | documented ("react-query = the single client data layer", `agentQuestionsStore.ts:9`, arch-review 2026-07-07 §3.5) |
| **effect-fetch hook** | `useState`+`useEffect`+`apiFetch` → `{data, loading, refresh}` (`useOrchestrator.ts:51`, `useOnboardingStatus.ts:26` — 2026-08-15) | | 9 | implicit — the pre-react-query style, still being written |
| **action-bundle** | `useXActions(deps) → {handleA, handleB,…}` (`useWorkspaceActions.ts:87` **640 lines**, `useIssueActions.ts:56`, `createBoardIssueActions.ts:33` factory) | | 10 | implicit |
| **ws/event hook** · **ui-state hook** | subscribes to `useBoardEvents` · local UI state, no IO | | 6 · ≈20 | implicit |
| **zustand store + `Actions` twin** | `useXStore = create<XState>()` + non-hook `xActions` for use outside React (7/8; `pluginViewStore` lacks the twin) | `stores/*Store.ts` | 8 | explicit for the direction (`boardPageStateGate.test.ts` #905 ratchet), implicit for the twin |
| **client-lib sub-kinds** (125 files; 102 pure; **85 test files** vs 43/244 components, 8/56 hooks) | pure view-model helper ≈80 (`criticalPath`, `mergeReadiness`, `boardDataReconcile`) · parser 8 (`agent-output-parser` + claude/codex/pi) · API transport 1 (`api.ts` — 5 raw `fetch(` bypasses) · **query-options module** 6 (`xQueryOptions` + `fetchX` + `invalidateX`) · hand-rolled module cache 5 (`settingsStore`, `timeEntriesCache`, `issueDetailBundleCache`, `clientInvalidation`, `useInbox`) · registry 7 (`VIEW_REGISTRY`, `SHORTCUT_REGISTRY`, `registerAction`, `appRoutes`) · pub/sub singleton / window-event bus 6 (`kanban:` ×3 vs `agentic-kanban:` ×3 prefixes) · design tokens 6 · **misplaced React in lib** 9 (`useBoardEvents.ts`, `useWebSocket.ts`, `MentionContext.tsx`, `queryClient.tsx`, `diff-highlight.tsx`…) + 4 pure `.ts` in `components/` | | | lib IS the "extract pure logic to test it" pattern; unnamed |
| **route/container** | `routes/BoardPage.tsx` (864 l) container → `BoardPageView` prop bag; URL parse/build only via `lib/appRoutes.ts` | `routes/` | 5 | documented + guarded (#446, `boardPageStateGate`) |

### The guard suite — the enforcement element (lane E)
Definition observed: a vitest suite asserting a property of the **whole repo tree** (or a spawned
repo script), importing little of what it checks. 28 files carry `@gate:always-run`; test-file
suffixes: `-guard` 15, `-ratchet` 4, `-parity` 3, `-drift` 3, `-boundary` 3, `single-source` 2,
`-scanner` 2, `-lockstep` 1, `-invariant` 2. `@gate:always-run` ≠ the guard set: 6 marked files are
selection-soundness pins, and **7 real tree-guards are unmarked** (`issue-number-single-source`,
`copilot-event-types-lockstep`, `dependency-pinning`, `branch-name-single-producer`,
`no-global-default-model`, `check-god-modules-script`, `scaffold-commit-covers-hooks`) because the
marker ratchet's regex misses their walker names. Rings inside the element: **allowlist
zero-tolerance scanner** (5, dominant for new rules) · **counted ratchet** `BASELINE: file→count` +
"no NEW" + "not stale" twin (4, dominant for retrofits; "Only SHRINK this list" copied verbatim, no
shared helper) · **parity/lockstep** of two artefacts (6) · import-graph/AST (2, the only non-regex)
· hook black-box spawn (5). Walker code (`readdirSync` recursion) is copy-pasted ≥8×; every baseline
lives inside its test file. **The client package is outside the mechanism entirely**
(`scripts/test-mine.mjs` PACKAGES = shared/server/mcp; its two guard suites `theme-tokens`,
`boardPageStateGate` are unmarked).

## Rules (allow-lists) and violations judged

Spec rules = depcruise's 14 + monitor/lib/scripts/mcp additions (see `pattern-language.json`).
Runtime violations after erasure of type-only edges — **5**, one pair:

| edge | verdict |
|---|---|
| `server-service → server-monitor` ×5 (`autodrive-stall-warning.service.ts → startup/monitor-cycle-rules.ts`; `monitor-butler.ts`, `butler-sdk/claude-loop.ts → startup/transient-errors.ts`; `plugin-loop-autoland-recovery.ts → startup/branch-commits.ts`; `plugin-loop-start.service.ts → startup/monitor-auto-start.ts countActiveWip`) | **real** — 3 targets are utilities that don't belong in `startup/` (pure `isTransientNetworkError`, `commitsAhead` git op, `monitor-cycle-rules` = policy that itself imports services → cycle); 1 is a service reaching into a 579-LOC orchestrator for a WIP counter. ONE ticket (relocate + extract). |
| draft `client-hook→client-component` ×16, `→client-route` ×2, `client-lib→hook/component/route` ×4, `component→route` ×2 | **all type-only** — DTOs (`IssueComment`, `MonitorStatus`, `Project`, `Tag`…) declared in the leaf that renders them; `Project` defined 3×, `WorkspaceInitial` 2× **with drift** (`sessionId: string` vs `sessionId?: string`). Not a rule question → ONE relocate ticket; never whitelist. |
| draft `server-route→server-db` ×41 | all `import type { Database }` — kept allowed; the tool no longer counts them |
| `server-db→server-scaffold` (`seed.ts → builtin-skills.ts`) | rule wrong — seeding built-in content IS db bootstrap; allowed in spec v2 |
| `server-route→server-butler` (`routes/butler.ts → butler/board-guide.ts`) | boundary wrong — a 1-file "element"; folded into `server-service` |
| `server-lib→server-repository/service` (`scripts/refresh-project-hooks.ts`) | boundary wrong — scripts are entrypoints; new `server-script` element, unconstrained |
| `server-service→UNASSIGNED` (`runtime-port.ts`, `uv-threadpool.ts`) | spec fix — `runtime-port` = env resolver → lib; `uv-threadpool` = boot side-effect → root |
| `server-startup→server-route/middleware` | allowed for the composition root (`route-setup.ts`); `monitor-setup.ts:168` defines 3 `/api/internal/*` routes inside startup — the only routes outside `routes/` → fold |
| `shared-lib→shared-schema` ×16 | right direction, but all 16 are the shared-db-op kind — the pure kinds must not reach schema (future rule once shared-lib is split in the spec) |
| `mcp-tool` | draft had no rule; repo has `mcp-no-server-internals` → added |

**Rules the code has that the draft lacked** (from depcruise, now seeded): `shared-is-a-leaf`,
`mcp-no-server-internals`, `client-no-drizzle-or-schema` (direct edges only — the transitive leak
below passes it), `client-lib-is-leaf`.

## Annual rings (one role, several home-grown styles)

The repo is ~3.5 months old, so these are **co-existing styles still being created**, not eras —
dates given as first→latest member. "Endorsed" = what docs/decisions say.

| # | role | variants (members · first→latest) | endorsed | verdict / direction |
|---|---|---|---|---|
| R1 | **service wiring** | factory `createXService(deps)` 58 (05-26→08-13) · fn-module `database: Database` per call 107 (05-16→08-08) · `= db` default 24 · module singleton export 7 (05-26→07-14, still consumed) · direct global `db` 4 | factory (`packages/server/CLAUDE.md`), silent on when fn-module is fine | ring — same role, style per author; unify direction: document fn-module as the stateless form, forbid new singletons + direct-global `db` (ratchet) |
| R2 | factory naming | `createXService` ≈40 · `createXOps` 5 (all 08-11..13, plugin decomposition) | — | new noun for the same shape → doc "Ops = sub-service extracted from a >800-line service" or rename |
| R3 | **domain errors** | `errors/AppError` family (statusCode-first, 05-26, frozen; ≈10 files, 39 throws) · per-service `XError(message, code)` 15 classes (05-26→08-01, ≈330 throws), each re-declaring its code union | B (`error-handler.ts:10-30`) | ring; name `coded-domain-error`, one `DomainErrorCode` union in `errors/`, migrate the 39 |
| R4 | registries | module Map + accessor · exported bare Map · factory | — | 3 registries, 3 shapes; unify only if a 4th appears |
| R5 | **reconciler placement / scheduling** | service-side `reconcileX(input, deps)` (2) · `startup/*-reconciler.ts` timer pairs (14) · **hand-rolled `setTimeout+setInterval`** 11 files (newest `base-branch-health-reconciler.ts` **08-16 08:31**) vs `startPeriodicSweep` helper 2/13 (since 08-16 11:13, #529) | `periodic-sweep.test` header claims it is "the scheduler every reconciler depends on" — aspiration | ring; #529 filed — adoption 2/13, and a fresh reconciler landed the same day on raw setInterval → needs an allowlist scanner, not just the helper |
| R6 | **routes: service-backed vs repository-backed** | 40/45 via `createXService` · 5 read-model routes compose repos + inline aggregation (`digest.ts` 263 LOC, `focus.ts`, `insights.ts`, `time-report.ts`, `runbooks.ts` — burst 05-29..06-04) + 13 mixing repos beside services | thin adapter (`packages/server/CLAUDE.md:7`) | small ring; unify → move aggregation to `lib/` projections (as `board-health-events-format.ts` did) |
| R7 | **CLI data access** | in-process repos 17 / services 11 · REST `fetch()` to the live server 9 (`tag.ts:32` lists tags via GET while `issue.ts` uses a repository) | none states when REST is required | ring; overlaps #499 — fold the placement sentence into it ("in-process; REST only for live SessionManager/boardEvents") |
| R8 | **client data fetching** | A. component/hook-local `useEffect`+`apiFetch` **117 components + 9 hooks** (05-01→**08-16**) · B. hand-rolled module cache 5 (06-11→**08-13** `useInbox.ts` new) · C. react-query 6 lib + 5 hooks + 6 components (06-23→08-16) | C ("the single client data layer") | the biggest ring in the repo: endorsed variant is the smallest; new members join the OLD rings weekly. Bypass evidence: 16 files hit `/api/preferences` raw vs 24 via `settingsStore`; `SettingsPanel.tsx:358` `apiPut`s without `invalidateSettings()`. Mechanism = co-occurrence ratchet (`useEffect`+`apiFetch` per file, DOWN only) |
| R9 | client shared state | props-drilling `BoardPage`→`BoardPageView` (20 useState capped by `boardPageStateGate`) · 8 zustand stores (07-02→08-06) · react-query | stores + react-query | legit *ratcheting* ring, already guarded — leaves DTOs stranded (`Project` ×3) |
| R10 | mcp board-reach | DBSING 27 (05-01→06-15) · DEPS 39 (05-01→06-25) · HTTP 28 (05-13→08-15) | DEPS + "HTTP for in-memory state" | DBSING vs DEPS is a ring (0/30 tool tests mock `../db`, 15 use deps); DB-vs-HTTP is documented heterogeneity, convention-only |
| R11 | shared-lib exposure | BARREL-only 10 · BARREL+DEEP 16 · DEEP-only 50 (~30 pure and barrellable) · 72 hand-listed `./lib/*` subpaths incl. 3 duplicate `.js` aliases used both ways | only the negative half (node-only ⇒ deep) | ring; `"./lib/*"` export pattern + one spelling; risk nil (barrel guard exists) |
| R12 | column-vocabulary home | schema `as const` next to the table (`DEPENDENCY_TYPES`, `WORKFLOW_NODE_TYPES`, `DRIVE_STATUSES`) · lib (`TERMINAL_WORKSPACE_STATUSES`, `ISSUE_PRIORITIES` 08-16) · types (type-only) · nowhere (`sessions.status`) | — | ring; schema-side is newer and growing, undocumented (relates to #567/#570 vocab tickets) |
| R13 | **preference reading** | canonical `preferences.repository.ts` + ~35 `*PrefKey()` helpers + `settings-registry` `getBool/getNumber/getJson` (polarity-ratcheted) · **8 clone functions** (`getAllPreferences` ×5, `getPreferenceValue` ×3, all born 06-18 "repository extraction" wave) · **20 files querying `schema.preferences` raw** (startup 8, services 4, mcp 8) · ~25 inline `` `board_strategy_${id}` ``-style keys whose helper exists (`board_strategy_` 11 sites + a 2nd deriver `client/lib/strategy-targets.ts:77`; `board_autodrive_` 9 vs helper 1 user) | canonical (`docs/domain/preferences-config.md`, "most drift-prone surface") | ring, 3 styles; ratchets: no raw `schema.preferences` outside the repository; no backtick key with an existing helper |
| R14 | **time / `now` injection** | CLAUDE.md:172 rule `now?: string`/`nowOverride` — measured in staleness/expiry code: 56 injected, **31 raw** (`auto-merge-orchestrator.ts:234`, `stranded-review-reconciler.ts:187`, `workspace-summary.service.ts:287-407` TTL checks); and **6 spellings inside the injected style**: `now?: string` 31, `nowMs: number` 22, `nowIso` 9, `nowOverride?` 6, `now?: number` 6, `now?: Date` 4 | one spelling documented | ring + spelling ring; rule: `now?: string` for ISO persistence, `nowMs` for arithmetic; ratchet raw calls |
| R15 | **branch parsing `ak-<N>`** | 6 regexes in 5 files (`git-service/worktree.ts:51`, `worktree-ports.ts:28`, `hand-merged-branch-reconciler.ts:21`, mcp `session-history.ts:44`, cli `system.ts:242`) with different anchoring (the "fix-ak-104" double-match was fixed in one) — derivation is unified (`suggestBranchName`, 15 users) | — | ring; already filed as scout **#548** — sibling evidence only. 4 `slugify` clones alongside |
| R16 | **server-port ladder / env naming** | `process.env.KANBAN_SERVER_PORT \|\| PORT \|\| "3001"` copied **10×** (oldest 05-26) vs `shared/lib/board-server-url.ts resolveBoardServerPort()` **born today** with 4 users · env toggles `KANBAN_*` (35, 8 undocumented) vs bare (`STUCK_BUILDER_TIMEOUT_MS`, `PLUGIN_VIEW_READY_TIMEOUT_MS`, `MOCK_AGENT`, `DB_URL`, `ALLOW_DB_DESTROY`, …), no env registry | — | ring in repair (helper landed, not drained — same state as #529); env naming rule + registry |
| R17 | **error signalling per layer** | routes: 213 inline `c.json({error}, 4xx)` beside the middleware's structural mapping · MCP: `mcpError/requireEntity` (25 tools) vs **36 inline `text: "Error: …"` literals in 16 tools + 7 private `text()` clones** · result objects `{ok:false}` (20 files) vs `{success:false}` (9) — no `Result<T>` | middleware mapping (`error-handler.ts`) | rings inside layers (per-layer difference itself is legit); pairs with R3 |
| — | NOT rings (measured): board event emission (one `createBoardEvents()` hub, DI'd, 0 singleton imports — the narrowed `broadcast` callback in 10 files is dependency-narrowing); logging (`console.* "[tag] …"` 791 tagged vs 44 untagged, 121 tags — an unnamed convention → `name` row); ids (`randomUUID` 76 files); validation per layer (MCP zod 84/87 vs routes `parseJsonBody` 27/44 + typeof ladders — technology difference; inside routes: 3 raw `c.req.json()` fold) | | | |
| — | small `unify` items: client event-name prefixes `kanban:` ×3 vs `agentic-kanban:` ×3; exec-adapter `code: number\|null` vs `-1`; `View` two senses | | | |

**In-flight unifications** (helper landed, ring not drained — the ledger tracks drain progress so the next round measures instead of re-discovering): `lib/periodic-sweep.ts` (#529, 2/13), `shared/lib/board-server-url.ts` (4/14), `auth-rotation-ring.ts` (2/2 done — the good precedent).

Legitimate heterogeneity (NOT rings): reconciler injection `deps:{getSessionManager}` vs `database = db` (needed only when a sweep launches agents); inline `style={{width}}` beside Tailwind; `createPortal` for 3 menus; hand-rolled SVG charts.

## Residue and mixed buckets (domain vs technology)
- `server-lib`: ≈30 domain projections : ≈10 technology : 7 scripts (now their own element).
- `services/`: ≈26 % technology files unfenced (fenced only in `agent-provider/`, `session-manager/`, `butler-sdk/`, `stack-profile/`, `project-scaffold/`).
- `shared/lib`: ≈47 % technology (node-adapter 32, stream-parser 15, telemetry, db-client) in a bucket the spec calls one element. Worst mixed: `workspace-status.ts` (db-op + 4 pure liveness predicates → **the client now bundles drizzle + the whole schema** through `client/src/lib/detectAgentStall.ts:1`, `hooks/useFleetLiveStats.ts:6` since #498 — passes `client-no-drizzle-or-schema` (direct edges) and `barrel-client-safety` (walks the barrel only)), `drive-retro.ts`, `strategy-objective-file.ts` (parse + fs + `git commit`), `ticket-context.ts` (render + write).
- `client/lib`: ≈95 domain : ≈30 technical, flat; `viewRegistry.tsx` 653 l (registry + SVG icons + palette copy).
- `startup/`: 13 root + 17 monitor engine + 19 sweeps + 7 utilities/decisions — a role bucket named after a placement.

## Intent gaps — invariants the docs state that nothing enforces
| invariant | today | mechanism |
|---|---|---|
| layering `routes → services → repositories → db` | enforced for `services/` (0 drizzle) — **`startup/` outside every rule** (30/54 drizzle, 28 global `db`) | depcruise `startup-bypasses-repositories` at warn + backlog, or move monitor/sweeps under `services/` |
| "spawn Node with `windowsHide: true`" | 18/20 spawning service files comply; no scanner (heuristic 22/29 sites lack it on the spawn line) | allowlist scanner like `git-exec-single-spawn` (allow `process-exec.ts`, `project.service.ts:openFolder`) |
| "edit only the shared git-service file" | `git-service-contract.test` is a canary; nothing asserts the 2 re-exports stay 1-line | content-equality scanner |
| "never `git reset --soft` in a worktree" / "no `--no-edit` on rebase" | 0 tests | regex scanner over prod + hooks + skills |
| "hook commands `$CLAUDE_PROJECT_DIR`, forward slashes" | scaffold OUTPUT asserted; committed `.claude/settings.json` unchecked | parity test on `.claude/settings.json` |
| "project skills not in `builtin-skills.ts`" · CLAUDE.md board-feedback ↔ `buildBoardFeedbackSection` | 0 | parity / lockstep |
| decision 005 status-view read side | write side ratcheted; **13 prod files still compare `=== "Done"/"Cancelled"` raw** (`board-status.ts`, `merge-cleanup.service.ts`, `plugin-loop-stall.ts`, mcp `get-board-status.ts`) | ratchet over raw terminal-name comparisons |
| decision 008 start policy is THE switch | 2 tests import it; no scanner that every auto-start path calls `resolveStartPolicy` | allowlist scanner like `provider-resolution-single-source` |
| `BACKGROUND_SERVICES` order "keep stable" + every sweep registered | comment-only; 3 sweeps start from `services/` | test: every `startup/*` `start[A-Z]\w+` export is referenced from the registry |
| client: `apiFetch` the one transport (5 raw `fetch(`), URL only via `appRoutes` (convention), settings via `settingsStore` (16 raw), react-query the data layer (117 effect-fetch files, growing) | none | scanner / co-occurrence ratchets; first add `packages/client` to `test-mine` PACKAGES + mark its 2 guards |
| `always-run` marker = guard set | 7 real guards unmarked, 6 marked non-guards | make the role declarative (`@guard: <kind>`) or dir/naming rule; shared `walkPackageSources()` + `ratchetBaseline()` helper |
| MCP "delegate in-memory REST state" | convention | allowlist test on tools touching `workspaces.status`/`sessions` |
| `check:arch` green | **red on master** (2 edges) + stale "Backlog: 0" comments | fix + wire into the always-run set (it is already in `check:arch`) |

## Proposals — filed as `pattern:` tickets
Verbs: **name** (doc row + naming/placement rule + guard), **enforce** (guard for a stated
invariant), **unify** (ring → one style), **fold** (one-off into an existing element),
**introduce** (only where ≥2 sites would use it today — none qualified this round; every proposal
names or folds something present ≥2×), **relocate**. Filed 2026-08-16 as **#583–#617**:

| # | verb | proposal |
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

Highest-payoff first (members × churn): #594 service⇏monitor (the only runtime violations), #595 startup layering, #596 transitive client-safety (drizzle in the browser bundle today), #602 `check:arch` red on master, #601 client outside the guard mechanism, #603 client data-fetching ring, #613 preference-reading ring, #583 guard suite.

## How to re-measure
```
# from the repo root; tool lives in code-metrics-skill/pattern-language/tools
python <skill>/tools/pattern_edges.py --spec docs/pattern-language/pattern-language.json --scan . --violations
python <skill>/tools/pattern_edges.py --spec docs/pattern-language/pattern-language.json --scan . --diff docs/pattern-language/baseline.json   # erosion
python <skill>/tools/pattern_edges.py --spec … --scan . --include-type-imports    # DTO-placement smell (client)
python <skill>/tools/vocab.py --repo . --roots packages/server/src packages/client/src packages/shared/src packages/mcp-server/src --docs CLAUDE.md docs/decisions
pnpm lint:arch   # the repo's own rule file — must be green
```
Refresh `baseline.json` (`--json`) with every round; log the round in `ledger.md`.
