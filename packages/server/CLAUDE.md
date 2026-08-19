# Server Package — Architecture Patterns

## Self-HTTP calls are an anti-pattern
A service must never `fetch('http://127.0.0.1:PORT/api/...')` to call its own server. Instead, accept the target service function as a constructor/factory parameter (dependency injection). Self-HTTP calls: create a hard runtime dependency on port availability, bypass TypeScript types (JSON round-trip), are impossible to unit-test without a running server, and swallow errors through JSON re-parsing. The fix: pass `createWorkspace` (or similar) directly to the service that needs it.

## `provider-pair` — one module per agent provider, same shape (#593)

Four providers are registered (`claude`, `codex`, `copilot`, `pi`) and several capabilities
ship as a per-provider module with a mirrored export shape:

| Capability | Module | Providers |
|---|---|---|
| provider adapter | `agent-provider/<name>-provider.ts` | all four |
| usage-limit detection | `services/<name>-rate-limit.ts` | claude, codex |
| interactive login | `services/<name>-login.service.ts` | claude, codex |
| auth rotation | `claude-subscription-ring.ts` / `codex-license-ring.ts`, both over the generic `auth-rotation-ring.ts` | claude, codex |

**The rule: a capability is either PRESENT for a provider or DECLARED absent — never just
missing.** A four-provider registry with two-provider adapters is fine; what is not fine is
that nothing said whether copilot and pi were a decision or an oversight, because that is
how a provider silently gets second-class behaviour.

`provider-exit-behavior.ts` is the precedent to copy: a `Record<ProviderName, …>` the
compiler forces to be exhaustive, with copilot and pi given an explicit
`makeNoopBehavior(…)` rather than being absent. `auth-rotation-ring.ts` is the other — its
header exists to state that the two rings are "identical logic once".

`provider-pair-parity.test.ts` (`@gate:always-run`) enforces it: every provider either has
the module or appears in that capability's `unsupported` map WITH a reason, and an
`unsupported` entry whose module has since appeared fails too — a stale exemption
permanently excuses a provider that no longer needs excusing. Adding a fifth provider turns
every capability red until it is classified.

Still ad-hoc, and deliberately left so: the two login ROUTES
(`POST /api/preferences/{claude,codex}-login`) take different body params (`configDir` vs
`codexHome`) and are public API the UI calls. Table-driving them means changing that
contract, which is a bigger change than this ticket's "document the rule, add the test".

## How a service is WIRED — factory vs fn-module, and the ONE injection seam (#604)

Both shapes are legitimate. Say which you are writing and why:

| Shape | Use it when | Signature |
|---|---|---|
| **factory** `createXService(deps)` — 63 of them | the service is stateful or orchestrating: it holds collaborators, a cache, a queue, or wires several other services together | one `deps` OBJECT for new factories (`{ database, boardEvents, … }`), never positional — a positional list stops being readable at three arguments and every added collaborator is a breaking change |
| **fn-module** `doX(id, database)` — 107 of them | the service is stateless: each function is a transaction over arguments | plain exported functions; no factory ceremony for something with nothing to hold |

**The injection seam has TWO sanctioned spellings, and this is the part that is enforced.**
The seam was spelled SIX ways across 64 sites, so you could not tell whether a service was
db-injectable — the thing you need in order to test it — without opening it and reading the
signature. Exactly the defect #614 found in `now`, and it gets the same remedy:

- **`database: Database = db`** — fn-modules (47 sites, the dominant form).
- **`deps.database ?? db`** — factories taking a `deps` object (6 sites).

`db: Database = realDb`, `{ database = db }` destructuring, `database: typeof db = db` and
`deps.db ?? realDb` are grandfathered at their current counts by
`service-wiring-ratchet.test.ts` (`@gate:always-run`) and may **only shrink**. A seventh
spelling fails the gate. A service that imports the global `db` with NO seam at all fails
outright — it cannot be tested against a fixture database, and that check is zero-tolerance
because the count is currently zero.

**Module singletons** (`export const xService = createXService({ database: db })`) are not
banned — they are how a route gets a ready instance without wiring — but they pin the
service to the global db at module load, so a consumer cannot swap the database.
`routes/config-export-import.ts` already builds its own `createPreferenceService({database})`
for a service another route took as a singleton. Frozen at 6, shrink-only.

**`createXOps` is not a second kind.** All five are plugin sub-services extracted from an
oversized service, which is the only meaning the noun carries: *a sub-service split out of a
>800-line service*. Anything else is a `Service`. Frozen at 5.

## Circular imports
Route modules that need services (e.g., `sessionManager`) should receive them via factory functions or lazy getters, not direct imports from `index.ts`.

## MCP server DB path
Uses `import.meta.dirname` relative path (`../../server/kanban.db`) since pnpm changes CWD per package. Scripts using `import.meta.dirname` from `packages/server/src/scripts/` must account for depth — `../../../kanban.db` points to repo root, not the actual DB.

## Agent process survival across hot-reload
Agent subprocesses are spawned with `detached: true` + `proc.unref()` in `agent.service.ts` so they are not in the server's process group and survive a tsx hot-reload restart. Detached is enabled for all agents that don't need `shell: true` on Windows (including copilot with npm-loader). PIDs are persisted to `sessions.pid`. For detached agents, stdout is redirected to a session output file (`os.tmpdir()/kanban-session-${sessionId}.out`) instead of a pipe — this prevents EPIPE crashes when the parent process dies and preserves output across restarts. A file watcher polls for new content and feeds it to the broadcast handler.

On startup, `server-start.ts` checks which "running" sessions still have a live PID (`process.kill(pid, 0)`). Dead sessions are marked "stopped" and their workspaces set to "idle". Surviving sessions are reattached: the session manager restores in-memory state (context, provider), the output file watcher resumes from the last byte offset, and a PID poll monitors for exit. The shutdown handler only calls `agentService.killAll()` on `SIGINT` (user Ctrl+C), not `SIGTERM` (hot-reload signal), so agents survive server restarts but are cleaned up on intentional shutdown.

**Exit-before-output drain (#909) — don't remove it.** The output file watcher polls every 500ms (5s for a reattached PID poll), so a detached agent that writes output and crashes within one poll interval would fire `exit` before its tail was read — and launch-failure classification, reading `hadSubstantiveOutput`, would MISCLASSIFY the real run as a zero-output launch failure (the "~1s, 0 tokens = launch-failed" false positive). The watcher therefore exposes `drainNow()` (a synchronous read-to-EOF that bypasses the `closed` guard so it works during teardown); BOTH exit paths (live proc `exit` handler and the reattach PID-poll exit) MUST call `drainNow()` before emitting the exit event. Removing or reordering that call reopens the race. Regression: `agent-exit-output-drain.test.ts`.

## WebSocket setup
`@hono/node-ws` requires `createNodeWebSocket({ app })` then `injectWebSocket(server)` after `serve()` returns.

## Test agent substitution
`AGENT_COMMAND` env var overrides the agent binary for E2E tests; `MOCK_AGENT=1` globally enables mock agent; the mock agent is otherwise selected by the `claude_profile` preference being `"mock"` (see `isMockProfile` in `agent-settings.service.ts`). The old standalone `mock_agent` boolean preference was removed in favor of the profile dropdown. The `mock_agent_profile` and `mock_agent_delay_ms` preferences select the mock *behavior* profile/timing — `resolveAgentSettings` (`agent-settings.service.ts`) appends them to the mock command as `--profile`/`--delay-ms` (sanitized, since the mock command runs with shell:true). Mock agent must use `pathToFileURL()` to resolve absolute path to `packages/server/node_modules/tsx/dist/loader.mjs` as a `file://` URL in `--import` — bare `--import tsx` fails with `ERR_MODULE_NOT_FOUND`.

## Adding settings keys — ONE place: the typed registry (#903)
Global static settings have a SINGLE source of truth: `SETTINGS_REGISTRY` in `@agentic-kanban/shared/lib/settings-registry.ts`. Adding a setting is **one edit there** (`key: { type, default }`). Everything else DERIVES from it:
- `SETTINGS_KEYS` (server `preference.service.ts`) = `SETTINGS_REGISTRY_KEYS` + the dynamic per-harness keys (`allHarnessSettingKeys()`),
- the client `Settings` TS type + `DEFAULT_SETTINGS` (re-exported through `settings-shared.ts` → `SettingsPanel.shared.tsx`),
- so a setting referenced in code but absent from the registry is a **compile error**, not a runtime 422. The schema IS the gate. Parity is locked by `settings-registry-keys.test.ts` (server) + `settings-registry.test.ts` (shared).

Use the typed accessors `getBool` / `getNumber` / `getJson` (also from the registry module) instead of scattered `=== "true"` / `Number(...)` reads; each registry entry declares its `type`.

A key NOT in `SETTINGS_KEYS` (and not matching `isAllowedDynamicKey`) is still REJECTED LOUDLY on write — the route returns **422** with `{ ok: false, applied, droppedKeys, error }` (#874; was a silent drop that bit `auto_rebase_on_continue` / `skip_preflight`). Per-project dynamic keys go through `isAllowedDynamicKey` (`dynamic-preference-keys.ts`) instead of the registry.

**Write-time provider divergence guard (#903):** `PUT /api/preferences/settings` now REJECTS (422, nothing persisted, `divergence` field on the body) a `provider`/`*_profile` write that would put the global prefs out of sync with the ACTIVE project's Strategy Bullseye. `updateSettings` returns `{ applied, dropped, divergence }`; `checkProviderDivergenceGuard` projects the write onto current prefs and runs `resolveProviderDivergence`. This makes the old passive divergence banner an enforced invariant and retires the `set-provider-default` skill's reason to exist. The guard now fires on **ALL** pref write paths — HTTP/CLI/MCP/internal all route through the shared `setPreferenceChecked` (`@agentic-kanban/shared/lib/checked-preference-write`), which also regenerates `objective.md` for `board_strategy` writes — so the #903 MCP side door is closed (arch-review §3.3, fixed b847bb84); prefs no longer drift from the Bullseye on any WRITE path. Residual caveat (structural, not a write bug): the guard resolves the provider **quota-free** while real launches are quota-aware, so a static pref can't perfectly mirror a time-varying selection (Ticket 12 / quota boundary). The guard only fires when the write touches a provider/profile key, so unrelated toggle saves are never blocked by a pre-existing untouched drift. The config import route (`config-export-import.ts`) calls `updateSettings` directly and surfaces `droppedKeys` as NON-fatal; it sets the Bullseye and provider in the same call so the projected map is self-consistent.

## Logging — `console.<level>("[<tag>] …")`, one tag per file (#616)
There is no logger module and no plan for one; the convention IS the interface. Measured in
`services/` + `startup/`: **732 tagged lines vs 22 untagged**, across 98 distinct tags
(`[monitor]` 75, `[startup]` 66, `[workflow]` 59, `[workspaces]` 54, `[workspace-merge]` 48).
That prefix is what makes a 1600-line server log greppable per subsystem, so an untagged
line is not a style nit — it is a line nobody will find later.

- **Tag = the file's noun**, one per file. Reuse the existing tag for the subsystem rather
  than minting a variant (`[workspace-merge]`, not `[merge-workspace]`).
- **`[fatal]` is reserved** for `uncaughtException`/`unhandledRejection` (see root CLAUDE.md).
- A **background sweep takes an injected `log`** (born-blocked / workflow-node-divergence /
  plugin-loop / worker-daemon already do) so its output is testable and can be silenced.
- `console-tag-ratchet.test.ts` grandfathers today's 22 untagged calls and fails on a 23rd.
  Most survivors are `console.warn(variable)` forwarding a pre-tagged string — legitimate,
  hence a ratchet rather than a ban.

## `startup/` is THREE roles, not one — root vs monitor engine vs sweeps (#595)

`startup/` is named after a placement, not a role, and 49 files sit in it. Three different
things live there, and only the first is actually about starting up:

| Role | What | Examples |
|---|---|---|
| **composition root** | genuinely boot-time wiring, runs once | `route-setup`, `background-services`, `startup-tasks`, `readiness`, `process-handlers`, `scheduled-tasks`, `session-restore`, `fk-alignment` |
| **monitor engine** | the Autopilot, ~5.5k LOC, runs EVERY cycle | `monitor-setup`, `monitor-cycle`, `monitor-auto-start`, `monitor-backlog`, `monitor-contract`, `monitor-eligibility`, `monitor-file-contention`, `monitor-helpers`, `monitor-project-scheduler`, `monitor-workspace-actions`, `monitor-cycle-actions`, `merge-workflow`, `exit-workflow`, `auto-merge-orchestrator` |
| **sweeps** | periodic passes, the **background sweep** kind above | the 13 `*-reconciler`, `*-reaper`, `*-scanner`, `worker-incoming-sweep` |

**Why the split matters, concretely.** `.dependency-cruiser.cjs` enforces
`routes → services → repositories → db`, and `startup/` was outside EVERY rule in it — so
the layering was enforced for `services/` and evaded by the monitor engine next door. Not
theoretical: 30 of the 49 files value-import `drizzle-orm` and 28 import the `db` value.

Two findings in #594/#595 made it concrete. A query extracted OUT of `startup/` into
`services/` tripped `services-bypass-repositories` within minutes, having sat unnoticed for
months. And three live `/api/internal/*` routes defined inside `startup/monitor-setup.ts`
were exempt from `routes-not-down-to-persistence` and `no-circular` — moving them to
`routes/internal-monitor.ts` failed both immediately (a `db` value-import, and a cycle back
into `startup/`), and fixing them is what moved `monitorDrivenProjectIds`/`monitorShouldRun`
into `services/start-policy.service.ts`, which already owned that decision.

**Rules now in force:**
- `startup-bypasses-repositories` (depcruise, **warn**, backlog 30) — same shape as the
  `services-bypass-repositories` rule that drained from 76 to 0. Warn rather than error per
  this file's own severity policy: a rule that cannot go green today belongs at warn with its
  count written down. Tighten per slice and lower the number.
- **No route DEFINITIONS in `startup/`.** `route-setup.ts` is the sanctioned exception — it is
  the composition root, and mounting is its job. (It still defines one handler inline,
  `POST /api/workspaces/:id/review`; that is the remaining item, not a licence for more.)
- A new sweep is a **background sweep** (registered in `BACKGROUND_SERVICES`) and should reach
  the DB through a repository, not drizzle.

The physical `startup/` → `monitor/` + `sweeps/` move stays open: it is a 36-file rename that
would collide with every in-flight branch, and the rule above buys most of its value now.

## Named kinds in `startup/` and `services/` (#584, #585, #586)

Three shapes that were consistent in code and nameless in docs. Each now has a guard suite, so
the rule is checked rather than remembered.

| Kind | Shape | Rule | Guard |
|---|---|---|---|
| **background sweep** | crash-safe periodic pass over DB state: `reconcileX(deps, now?) -> Report` behind a module-singleton `startX(deps, intervalMs)` / `stopX()` timer pair. Reconciler / reaper / scanner / pruner / scheduler are sub-flavours of the one kind. | Every start/stop pair under `startup/` or `services/` is registered in `BACKGROUND_SERVICES` (`startup/background-services.ts`, array order = start order = reversed shutdown order) — or is listed in the guard's `NOT_A_SWEEP` map with a reason. Placement does NOT decide membership: three sweeps live under `services/` and are registered. | `background-sweep-registry.test.ts` |
| **decision function** | pure sync verdict co-located with the executor that acts on it: `decideX(row) -> {action, reason}`, `classifyX(...) -> union`, `shouldX(input) -> boolean`. | No `await`, no `db/` or `repositories/` call. The separability is the whole value: it turns a table of cheap cases into the test, while the sweep around it needs a database. | `decision-function-purity.test.ts` |
| **prefMap resolver** | prefs/env/context -> ONE decision value: `resolveX(prefMap, ctx)`, pure and synchronous. | **First parameter named `prefMap` implies pure.** `resolve*` alone does NOT — ~10 async db-reading `resolveX(id, database)` functions are ordinary services and stay that way. | `prefmap-resolver-purity.test.ts` |

Both purity guards check the FUNCTION, not the file: these live beside the db-reading code that
calls them, so a file-level import scan would have to fail them or be relaxed into uselessness.
They slice the declaration with `sliceTopLevelFunction` from the shared guard machinery.

## What a pass RETURNS — `PassReport` (#592)

The `run*` / `sweep*` / `reap*` / `reconcile*` family — 43 of them across `services/` and
`startup/` — is one kind (see **background sweep** above) that had ~20 different result
interfaces: `{checked, closed, released, held}`, `{scanned, reaped, skippedAhead,
skippedRunning}`, `{landed, held}`, `{checked, clearedNodes, convergedToDone}`. Several
return a bare `number` or `void`, so "found nothing" and "reported nothing" are the same
value.

`lib/pass-report.ts` is the common core, and a pass **extends** it rather than being
replaced by it — its own outcome lists stay, which is the only reason adoption is safe to
do mechanically:

```ts
export interface BornBlockedSweepResult extends PassReport {
  closed: string[]; released: string[]; retriedAndReleased: string[]; held: string[];
}
const result: BornBlockedSweepResult = { ...emptyPassReport(rows.length), closed: [], … };
recordActed(result, row.workspaceId, "close");      // it changed something
recordSkipped(result, row.workspaceId, "hold");     // it deliberately left it alone
```

**`acted + skipped` may be LESS than `scanned`, on purpose.** A candidate that threw is
neither, so it stays in the remainder that `formatPassReport` prints as `N unaccounted` —
a pass that swallowed failures must not read as a clean run. `passReasonCounts` groups the
reasons for a digest or a monitor.

Not in `packages/shared`: every pass is server-side, and `shared/lib` is for code more than
one package needs (#590).

Adopters: `born-blocked-reconciler`, `workflow-node-divergence-reconciler`,
`worker-incoming-sweep`, `terminal-workspace-reaper`, `hook-wiring-audit.service`. Migrate
the rest opportunistically, batched by directory — a new pass should start here.

## Guard suites — the kind, its marker, and its shared machinery (#583)

A **guard suite** is a test whose subject is the REPO TREE rather than a module: no raw `git`
spawn outside the adapter, no untagged `console.*`, one declaration per wire DTO, a spelling
ratchet, a god-module scan. The kind exists because such a suite is invisible to
`vitest related` — it reaches state outside its own import graph, so nothing it asserts about
is in its imports, and a scoped test run silently drops it.

- **Declare it**, don't hand-list it: a top-of-file `// @gate:always-run` marker. `scripts/test-mine.mjs`
  builds its always-run set by SCANNING for that marker (recursively, every test extension), and
  `always-run-marker-ratchet.test.ts` statically re-derives the "reaches outside its own import
  graph" signature and fails on a matching file that carries none.
- **Use the shared machinery**: `packages/shared/__tests__/helpers/guard-scan.ts` —
  `walkPackageSources` (the tree walk, skipping `__tests__`/`node_modules`/`dist`/`.d.ts`/tests),
  `walkTestFiles`, `packagesRootFrom`, and `compareRatchet` (which reports BOTH over-baseline
  regressions and BELOW-baseline staleness, so a baseline shrinks instead of becoming a budget).
  Do not paste a private walker into a new guard: every copy is a place the SCAN can diverge from
  what the guard claims to cover — which is exactly how the pre-merge gate's own
  `countAlwaysRunGuardSuites` under-reported for months while the marker scan was correct.
- **A guard reports honestly.** The gate message names the guard set it ran (`+66 guard suites`);
  a number that quietly means something narrower than it says is worse than no number.

## Board API data enrichment
Workspace summaries computed server-side in board endpoint via single grouped query, attached to each issue as `workspaceSummary`. Prefer server-side aggregation over client-side joins.

## Board events (dual path)
WS `/ws/board/:projectId` broadcasts `board_changed` for fast updates. 30s polling fallback in `useBoardEvents` catches MCP/CLI/second-tab mutations. MCP tools call `notifyBoard()` (fire-and-forget `POST /api/internal/board-notify`). `board-events.ts` passed to routes via factory options. `onSessionExit` triggers board broadcast via projectId resolution.

## Session messages
All agent output persisted to `session_messages` table (fire-and-forget insert in `broadcast()`). Retrieved via `GET /api/sessions/:id/output`.

## Route factory options
Routes receiving `{ boardEvents }` via options and `getSessionManager` via argument. `createRoutes` in `routes/index.ts` passes both to `createWorkspacesRoute` and `createWorkspaceActionsRoute`. Internal `POST /api/internal/board-notify` lives inside `createRoutes` for same boardEvents access.

## Workspace creation (one-step)
`POST /api/workspaces`: resolves issue → project → repoPath, creates git worktree (with optional `baseBranch`), inserts DB record, auto-launches agent. `createWorkspacesRoute` receives `getSessionManager` and `boardEvents` via factory. If worktree/launch fails, still returns 201 with workspace record + `error` field.

## Direct workspaces
`isDirect: true` → no worktree, `workingDir` = project's `repoPath`, branch auto-detected via `gitService.getCurrentBranch()`. Diff uses `git diff HEAD` + `git ls-files --others --exclude-standard` (to surface untracked files). Merge is no-op (just closes). `baseBranch` is null.

## Session resume chain
Claude's internal `session_id` captured from `system/init` stream-json events in `session.manager.ts broadcast()`, stored in `sessions.claudeSessionId`. On relaunch, `resumeFromId` passes `--resume <id>` to agent.

Pi's provider resume id is the first `{"type":"session","id":"..."}` JSONL
header. It is stored in the same legacy `sessions.claudeSessionId` column and
relaunched as `pi --session <id> --mode json -p <prompt>`. Do not rename the DB
column only for Pi; treat it as the provider-session-id slot until a broad schema
migration is justified.

## Re-chat and agent stdout
On Windows, `claude.exe` buffers stdout until stdin closed. Always use `stdin.end(prompt)` (never `stdin.write()` with stdin left open). Each re-chat spawns new process with `--resume <claudeSessionId>`. Graceful stop: `closeStdin()` → 2s wait → `kill()`. `stoppedByUser` set prevents exit handler from overwriting DB status.

## Pi task agents
Pi task workspaces are CLI subprocesses, not SDK sessions. `pi-provider.ts`
resolves `pi`/`pi.cmd`/`pi.ps1`, runs with `--mode json`, supplies the prompt via
`-p`, and loads board material with explicit `--extension` and `--skill` flags.
Pi 0.73.1 fails on `--approve`; never add that flag to server launch args.

Pi profiles are lightweight launch hints: `default` means Pi's own configured
defaults, while `provider/model` or `provider:model` is split into `--provider`
and `--model`. Auth remains Pi-native: provider env vars, Pi settings, and
`PI_CODING_AGENT_DIR` select the credential/config root.

The `.pi/plugin/agentic-kanban-hooks.ts` extension maps Pi `tool_call` events to
the existing `.claude/hooks` scripts. Bash commands flow through
`smart-hooks-runner.js PreToolUse`; write/edit tools flow through
`prevent-cross-worktree-writes.js`. Those are hard pre-execution blocks. Pi does
not currently provide a hard Claude-style Stop hook for the board's one-shot task
launches, so `check-uncommitted.js` does not gate Pi session exit. Server review
and merge preparation still detect dirty worktrees before landing.

## Branch suggestion/listing
`suggestBranchName()` format: `feature/ak-<issue-number>-<sanitized-title>`. Base branch uses `<select>` from `GET /api/projects/:id/branches`, falls back to text input on failure.

## Git worktree base branch
`createWorktree()` accepts optional `baseBranch`. When creating new branch, runs `git branch <branch> <baseBranch>` instead of defaulting to HEAD. The shared git service (`packages/shared/src/lib/git-service.ts`) is the single source of truth — both server and mcp-server re-export from it.

## Workspace setup scripts
Projects have `setup_script` (nullable text) and `setup_blocking` (boolean, default true) columns. `runSetupScript()` in `@agentic-kanban/shared/lib/setup-script.ts`. Blocking: await script then launch. Parallel: fire-and-forget. Non-fatal. PATCH `/api/projects/:id` updates setup script config.

**Windows shell gotcha — `setup_script` AND `verify_script` are POSIX-hostile.** `runSetupScript` spawns the script via `cmd.exe /d /s /c "<script>"` on Windows (`setup-script.ts:74`; the scaffold verify hook `scaffold/verify-gate-runner.js:334` does the same). A POSIX `./gradlew build` / `./mvnw verify` fails there — `cmd.exe` parses `./gradlew` as command `.` → `"Der Befehl ." ... nicht gefunden` (exit 1) → the pre-merge verify gate fails and the merge is silently withheld (`pre_merge_gate_failed`). Use the cmd-valid wrapper: **`gradlew.bat build`**, `mvnw.cmd verify`.

> **Fixed in #521 (`d718f44c66`), and the old note here named the wrong culprit.** It blamed
> `deriveVerifyCommand` (`shared/lib/verify-command.ts`). That function was never the
> problem — it derives from the persisted stack profile, whose commands already come from
> `gradleWrapper()`, which has always been win32-aware (`.\gradlew.bat`, or plain `gradle`
> when no wrapper file exists). The broken emitter was the marker-rule FALLBACK
> `deriveVerifyScript` (`services/project-setup.service.ts`), used when a project has no
> profile yet — i.e. a freshly-registered project, exactly when the gate is first derived.
> It hardcoded `./gradlew test`. It now calls `gradleWrapper()` like everything else, so
> the hand-set `verify_script_<projectId>` workaround is no longer needed for new JVM
> projects. Pinned by `project-setup.service.test.ts`, whose old assertion had frozen the
> literal `"./gradlew test"` and so pinned the bug on Windows.

## Issue numbers
Auto-incrementing per project via `MAX(issue_number) + 1` in `POST /api/issues`. `issue_number` added in migration 0006. The `MIGRATION_FILES` export in `packages/server/src/__tests__/helpers/migrations.ts` is now computed dynamically from the drizzle journal — no manual maintenance needed when adding new migrations.

## Review session must inherit claude_profile
When launching auto-review/manual-review from `index.ts`, read `claude_profile` from `prefMap` and pass as 6th arg to `sessionManager.startSession()`. Without it the review agent falls back to `ANTHROPIC_API_KEY` and gets 401. Pattern: `const claudeProfile = useMock ? undefined : (prefMap.get("claude_profile") || undefined);`

## Session summary endpoint
`GET /api/sessions/:id/summary` parses JSONL stream events into structured summary (files read/edited/written, commands, excerpts, errors, model, duration). No LLM call — pure server-side parsing in `parseSessionSummary()` in `sessions.ts`.

## Shared package src resolved live in dev
In dev (`pnpm dev`), `tsx watch --conditions development` resolves `@agentic-kanban/shared` to its `src/` TypeScript files directly — no manual `pnpm --filter shared build` needed after merging shared changes. The `"development"` export condition in `packages/shared/package.json` maps each subpath to its `src/` entry. Production builds still use the compiled `dist/` output (esbuild bundles shared in).

## Butler (warm Claude Agent SDK session)

The project butler is a persistent, warm Claude assistant — **not** the CLI-spawn
agent model used for board tasks. It runs in-process via the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`), one warm session per project.

- **Multiple named butlers.** A user can keep several butlers warm at once (e.g.
  "Smart"/opus and "Quick"/haiku). **Definitions are GLOBAL** (one set shared across
  projects), stored in the `butler_definitions` preference (JSON array of
  `{id,name,model}`), capped at `MAX_BUTLERS` (4), managed by
  `butler-definitions.service.ts` + `routes/butler-definitions.ts`
  (`GET/POST/PUT/DELETE /api/butler-definitions`). The `model` lives on the
  definition; **profile stays per-project** (shared by all of a project's butlers).
  Each project keeps its own warm session + context **per butler**. Routes select a
  butler with `?butler=<id>` (default `"default"`, the always-present legacy butler).
  `GET /api/projects/:id/butlers` returns the defs + per-project runtime state for the
  switcher. The client persists the active butler per project in localStorage; CLI/MCP
  take a `--butler` flag / `butler` arg. List via `pnpm cli -- butler list`.
- `butler-sdk.service.ts` owns a `Map<key, ButlerSession>` keyed by
  `butlerSessionKey(projectId, butlerId)` — plain `projectId` for the default butler
  (backward compat with the legacy unsuffixed pref keys), `${projectId}::${butlerId}`
  otherwise. Listeners are keyed by the same composite. Each session feeds turns into a
  single `query({ prompt: AsyncIterable<SDKUserMessage> })` via a `Pushable` queue, so
  conversation context stays warm in-process across turns (no `--resume` respawn).
  Token deltas are emitted as `ButlerEvent`s to listeners.
- **Why SDK, not CLI:** keeping a CLI `claude.exe` warm with stdin open does not
  stream on Windows (it buffers stdout until stdin closes). The SDK is a library
  call with a native async iterator — no stdio/TTY buffering, true streaming.
- **Auth/profile:** reuse a Claude profile env via `buildSpawnEnv(profile)`
  (`options.env`), so the butler authenticates the same way as the rest of the app
  (CLI login / API key / Bedrock). Per-project pref `butler_profile_<projectId>`
  overrides the global `claude_profile`. Switching profile **restarts** the session
  (different endpoint can't resume) — `POST /:id/butler/profile`.
- **Model:** lives on the (global) butler definition, values from
  `CLAUDE_MODEL_OPTIONS` ("", opus, sonnet, haiku). `POST /:id/butler/model?butler=<id>`
  updates the definition AND applies live via the SDK `query.setModel()` control
  request (no restart, context preserved). (Was a per-project `butler_model_<projectId>`
  pref before multi-butler; the model is now a property of the butler itself.)
- **Routes** (`butler.ts`, mounted under `/projects`): `POST /:id/butler/ensure`
  (start), `POST /:id/butler/message` (push a turn), `GET /:id/butler/stream`
  (SSE of `ButlerEvent`s), `DELETE /:id/butler` (stop + forget resume), `POST
  /:id/butler/interrupt` (stop the in-flight turn via `query.interrupt()`, session
  stays warm), `POST /:id/butler/model`, `POST /:id/butler/profile`, `GET
  /:id/butler/commands` (slash-command autocomplete), `GET /:id/butler/profiles`,
  `GET|PUT /:id/butler/skill`, `POST /:id/butler/ask` (synchronous — CLI/MCP).
  `GET /:id/butler` returns state incl. `selectedModel`/`selectedProfile`. The SDK
  `session_id` is persisted to `butler_session_<projectId>` and passed as `resume`
  on next ensure, so the butler survives server restarts.
- **SSE listeners are project-keyed, NOT per-session** (`listenersByProject` in
  `butler-sdk.service.ts`). "Clear context" and profile-switch stop+recreate the
  session; if listeners lived on the session, a stream reconnecting in that gap
  would attach to nothing and go dead. Keep them decoupled.
- **Context usage = `query.getContextUsage()`** (`totalTokens`/`maxTokens`), the
  real occupancy — NOT a sum of a turn's usage counts. `cache_read_input_tokens`
  accumulates across every tool round-trip in a turn, so summing balloons far past
  the true context size (saw 400k for a ~30k context).
- **Slash commands:** `GET /:id/butler/commands` merges the live SDK
  `supportedCommands()` with the repo's own `.claude/skills/*/SKILL.md`
  (`scanLocalSkills`), deduped — so repo skills are suggested even before the SDK
  finishes discovery / for a cold session.
- **Board orchestration:** the butler starts work via the one-step `POST
  /api/workspaces` flow (worktree + move to In Progress + launch agent). It must
  NOT use the `start_workspace` MCP tool to launch (bare worktree only), nor raw
  `git worktree`, and must never report success it hasn't verified via
  `get_issue`/`get_board_status`.
- **Bundled board guide:** `butler/board-guide.ts` ships a user-facing UI how-to as
  a string; `ensureBoardGuideFile()` writes it to a temp path each session start and
  the prompt references it via the `{{boardGuidePath}}` placeholder so the butler
  reads it on demand for "how do I…" questions (progressive disclosure — it stays
  out of every turn's context).
- **Markdown:** butler replies render via `@tailwindcss/typography` (enabled with
  `@plugin` in `app.css`; v4 has no `tailwind.config`). A `.prose` override strips
  the plugin's literal backtick pseudo-elements around inline code and adds a pill.
- `permissionMode: "bypassPermissions"` (+ `allowDangerouslySkipPermissions`) —
  there is no human in the chat loop to approve tool prompts.
- **`AskUserQuestion` is parked for the human, not auto-denied** (#459/#460/#461).
  The `claude_code` preset advertises the tool; with no `canUseTool` handler the SDK
  auto-denies it and the model gets an `is_error` tool_result whose whole content is
  the permission title `"Answer questions?"` — which the model then works around by
  re-asking in prose, one wasted turn each time. `butlerCanUseTool` therefore parks the
  call, broadcasts `{type:"question", askId, questions}`, and resolves when the user
  answers via `POST /:id/butler/answer`. Everything else stays allowed (bypass semantics).
  - **The answer is returned as `{behavior:"allow", updatedInput:{...input, answers}}`** —
    MEASURED end-to-end against the live butler; the CLI's own AskUserQuestion accepts
    pre-filled answers headlessly, so the tool completes normally. The alternative,
    `{behavior:"deny", message:"<answer>"}`, also reaches the model but records an
    answered question as a denied tool call (red error card, dishonest transcript) and
    was rejected for that reason. See the comment on `buildAnsweredPermissionResult`.
  - **No human ⇒ deny immediately**, never park: `hasInteractiveButlerListener` (i.e.
    `listenersByKey.get(key)?.size`) gates it, because `POST /:id/butler/ask` (CLI/MCP)
    blocks its caller and would otherwise hang for the full timeout — strictly worse
    than the old instant failure. Same for the timeout/interrupt/stop paths, each of
    which denies with a message that names the remedy.
  - Only ANSWERED questions go into the replayed `ButlerTurn` transcript (role
    `"question"`), so a reload shows what was chosen and never resurrects a parked
    question as answerable.

**Caution — worktree DB resolution:** a git worktree has no `packages/server/kanban.db`
(the file is gitignored, so it is never checked out into a fresh worktree). `data-dir.ts`
resolves the DB by file existence, so a worktree dev server finds no local db and falls
through to `~/.agentic-kanban/kanban.db` — a *separate* database from the main checkout,
with its own projects/IDs. A worktree server therefore runs against **different data**
than the main board, not the main DB (there is no shared file, hence no lock contention).
To point a worktree server at a specific DB, set `AGENTIC_KANBAN_DIR` or `DB_URL`.
