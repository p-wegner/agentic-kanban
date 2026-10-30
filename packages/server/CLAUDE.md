# Server Package — Architecture Patterns

Rules only. Rationale, incident history and design write-ups (verbatim, with section anchors) live in
**`docs/agent-guide/server-notes.md`** (#1759) — read the matching section there before changing an area below.
`claude-md-builder-budget.test.ts` caps this file; put new rationale in the notes page, not here.

## Rules
- **No self-HTTP.** A service never `fetch('http://127.0.0.1:PORT/api/...')`s its own server; inject the service function (e.g. `createWorkspace`) via factory/constructor.
- **Circular imports:** routes needing services (e.g. `sessionManager`) take them via factory functions or lazy getters, never from `index.ts`.
- **Errors (#587):** domain errors declare `readonly code: DomainErrorCode` (`errors/index.ts`); `DOMAIN_CODE_STATUS` is keyed by it, and an unknown code falls through to **500**. `AppError` subclasses are NOT deprecated. Guard: `domain-error-vocabulary.test.ts`.
- **One-offs (#612):** compat shims (`services/git.service.ts`, `mcp-server/src/git-service.ts`, `session.manager.ts`, `setup-script.ts`, …) are one-line `export *` re-exports on purpose — edit the shared file only. `lib/ai-operation.ts` is not middleware.
- **Provider parity (#593):** a capability is PRESENT for a provider or DECLARED absent (`unsupported` + reason) — never just missing. Copy `provider-exit-behavior.ts` (`Record<ProviderName, …>`). Guard: `provider-pair-parity.test.ts`.
- **Service wiring (#604):** factory `createXService(deps)` (stateful; one `deps` object, never positional) vs fn-module `doX(id, database)` (stateless). Injection seam is exactly `database: Database = db` (fn-modules) or `deps.database ?? db` (factories); other spellings are shrink-only; a service using global `db` with no seam fails. `createXOps` = plugin sub-services only. Guard: `service-wiring-ratchet.test.ts`.
- **Logging (#616):** `console.<level>("[<tag>] …")`, one tag per file (the file's noun; reuse the subsystem's tag). `[fatal]` is reserved. Background sweeps take an injected `log`. Guard: `console-tag-ratchet.test.ts`.
- **Settings (#903):** add a global setting in ONE place, `SETTINGS_REGISTRY` (`@agentic-kanban/shared/lib/settings-registry.ts`); everything else derives. Use `getBool`/`getNumber`/`getJson`. Unknown keys are rejected with 422 on write; per-project dynamic keys go through `isAllowedDynamicKey`. Pref writes go through `setPreferenceChecked` (provider/`*_profile` writes are divergence-guarded vs the Strategy Bullseye).
- **`startup/` (#595):** three roles — composition root, monitor engine, sweeps. No route DEFINITIONS in `startup/` (mount only; handlers in `routes/`; `openapi-route-coverage.test.ts`). A decision a non-`startup/` caller needs is a service — never import upward. New sweeps reach the DB via a repository.
- **Named kinds (#584–586):** *background sweep* (`reconcileX(deps, now?)` + `startX/stopX`, registered in `BACKGROUND_SERVICES`), *decision function* (pure sync `decideX/classifyX/shouldX`, no await/db), *prefMap resolver* (first param `prefMap` ⇒ pure). Guards: `background-sweep-registry`, `decision-function-purity`, `prefmap-resolver-purity` tests.
- **Pass results (#592):** a `run*/sweep*/reap*/reconcile*` pass returns a result that `extends PassReport` (`lib/pass-report.ts`: `emptyPassReport`, `recordActed`, `recordSkipped`). `acted+skipped < scanned` is deliberate (shows as "unaccounted").
- **Guard suites (#583):** a test whose subject is the repo tree carries `// @gate:always-run`; use `packages/shared/__tests__/helpers/guard-scan.ts` (`walkPackageSources`, `compareRatchet`) — never a private walker. Guards report honestly.
- **Vocabulary (#611):** *port* = TCP port (hexagonal sense is "adapter"); *gate* can refuse (the JVM limiter is a `semaphore`); *scanner* = a guard TEST; background passes are *sweeps*; bare *provider* = agent provider.
- **Shared src is live in dev** (`--conditions development`); no `pnpm --filter shared build` needed. Prod uses `dist/`.

## Runtime facts
- **MCP/server DB path:** `import.meta.dirname`-relative (pnpm changes CWD per package); mind depth from `src/scripts/`. A **worktree** has no `kanban.db`, so its dev server falls through to `~/.agentic-kanban/kanban.db` — a different DB; set `AGENTIC_KANBAN_DIR`/`DB_URL` to choose.
- **Agent survival across hot-reload:** agents spawn `detached: true` + `unref()` (`agent.service.ts`), stdout to `os.tmpdir()/kanban-session-<id>.out`, PID in `sessions.pid`; `server-start.ts` reattaches live PIDs. `killAll()` only on SIGINT, not SIGTERM. **Both exit paths must call the watcher's `drainNow()` before emitting exit** (#909, `agent-exit-output-drain.test.ts`).
- **WebSocket:** `createNodeWebSocket({ app })` then `injectWebSocket(server)` after `serve()`.
- **Test agent:** `AGENT_COMMAND` overrides the binary; `MOCK_AGENT=1` or `claude_profile` = `"mock"` (`isMockProfile`) selects the mock; its `--import` needs a `pathToFileURL()` of `tsx/dist/loader.mjs`.
- **Board data:** workspace summaries are server-aggregated (`workspaceSummary`). Board events are dual-path: WS `board_changed` + 30s polling fallback; MCP calls `notifyBoard()`. Routes get `{ boardEvents }` via options and `getSessionManager` via argument.
- **Sessions:** all output persists to `session_messages` (`GET /api/sessions/:id/output`; summary via `parseSessionSummary()`, no LLM). Claude `session_id` comes from `system/init` into `sessions.claudeSessionId` and is relaunched with `--resume`; Pi stores its JSONL-header id in the same column (don't rename it).
- **Re-chat stdout:** always `stdin.end(prompt)` (Windows `claude.exe` buffers until stdin closes); graceful stop `closeStdin()` → 2s → `kill()`; `stoppedByUser` guards DB status.
- **Workspaces:** `POST /api/workspaces` is one-step (worktree + record + launch; failure still returns 201 with `error`). `isDirect` = no worktree, `workingDir` = `repoPath`, merge is a no-op. Branch format `feature/ak-<n>-<title>`; `createWorktree()` takes `baseBranch`.
- **Review sessions** must pass `claude_profile` from `prefMap` as the 6th arg of `sessionManager.startSession()` (else 401 via `ANTHROPIC_API_KEY`).
- **Pi:** never add `--approve` (fails on Pi 0.73.1); hooks map via `.pi/plugin/agentic-kanban-hooks.ts`; Pi has no hard Stop hook.
- **Setup/verify scripts** run via `cmd.exe /d /s /c` on Windows — use `gradlew.bat`/`mvnw.cmd`, never `./gradlew`.
- **Issue numbers:** `MAX(issue_number)+1` per project; `MIGRATION_FILES` derives from the drizzle journal.
- **Butler** (warm Claude Agent SDK session, one per project × butler id): definitions are global (`butler_definitions`, max 4), profile per project. SSE listeners are project-keyed, not per-session; context usage is `query.getContextUsage()`; the butler launches work via `POST /api/workspaces`, never `start_workspace`; `AskUserQuestion` is parked for the human (deny immediately with no interactive listener). Full design, routes and rationale: server-notes "Butler".
