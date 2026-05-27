# Server Package — Architecture Patterns

## Circular imports
Route modules that need services (e.g., `sessionManager`) should receive them via factory functions or lazy getters, not direct imports from `index.ts`.

## MCP server DB path
Uses `import.meta.dirname` relative path (`../../server/kanban.db`) since pnpm changes CWD per package. Scripts using `import.meta.dirname` from `packages/server/src/scripts/` must account for depth — `../../../kanban.db` points to repo root, not the actual DB.

## Agent process survival across hot-reload
Agent subprocesses are spawned with `detached: true` + `proc.unref()` in `agent.service.ts` so they are not in the server's process group and survive a tsx hot-reload restart. Detached is enabled for all agents that don't need `shell: true` on Windows (including copilot with npm-loader). PIDs are persisted to `sessions.pid`. For detached agents, stdout is redirected to a session output file (`os.tmpdir()/kanban-session-${sessionId}.out`) instead of a pipe — this prevents EPIPE crashes when the parent process dies and preserves output across restarts. A file watcher polls for new content and feeds it to the broadcast handler.

On startup, `server-start.ts` checks which "running" sessions still have a live PID (`process.kill(pid, 0)`). Dead sessions are marked "stopped" and their workspaces set to "idle". Surviving sessions are reattached: the session manager restores in-memory state (context, provider), the output file watcher resumes from the last byte offset, and a PID poll monitors for exit. The shutdown handler only calls `agentService.killAll()` on `SIGINT` (user Ctrl+C), not `SIGTERM` (hot-reload signal), so agents survive server restarts but are cleaned up on intentional shutdown.

## WebSocket setup
`@hono/node-ws` requires `createNodeWebSocket({ app })` then `injectWebSocket(server)` after `serve()` returns.

## Test agent substitution
`AGENT_COMMAND` env var overrides the agent binary for E2E tests; `MOCK_AGENT=1` globally enables mock agent; the mock agent is otherwise selected by the `claude_profile` preference being `"mock"` (see `isMockProfile` in `agent-settings.service.ts`). The old standalone `mock_agent` boolean preference was removed in favor of the profile dropdown. The `mock_agent_profile` and `mock_agent_delay_ms` preferences select the mock *behavior* profile/timing — `resolveAgentSettings` (`agent-settings.service.ts`) appends them to the mock command as `--profile`/`--delay-ms` (sanitized, since the mock command runs with shell:true). Mock agent must use `pathToFileURL()` to resolve absolute path to `packages/server/node_modules/tsx/dist/loader.mjs` as a `file://` URL in `--import` — bare `--import tsx` fails with `ERR_MODULE_NOT_FOUND`.

## Adding settings keys
Preferences route uses a whitelist pattern — new settings require adding the key to both the GET `keys` array and PUT `allowedKeys` array in `packages/server/src/routes/preferences.ts`. Also add to `Settings` interface and `DEFAULT_SETTINGS` in `SettingsPanel.tsx`.

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

## Re-chat and agent stdout
On Windows, `claude.exe` buffers stdout until stdin closed. Always use `stdin.end(prompt)` (never `stdin.write()` with stdin left open). Each re-chat spawns new process with `--resume <claudeSessionId>`. Graceful stop: `closeStdin()` → 2s wait → `kill()`. `stoppedByUser` set prevents exit handler from overwriting DB status.

## Branch suggestion/listing
`suggestBranchName()` format: `feature/ak-<issue-number>-<sanitized-title>`. Base branch uses `<select>` from `GET /api/projects/:id/branches`, falls back to text input on failure.

## Git worktree base branch
`createWorktree()` accepts optional `baseBranch`. When creating new branch, runs `git branch <branch> <baseBranch>` instead of defaulting to HEAD. The shared git service (`packages/shared/src/lib/git-service.ts`) is the single source of truth — both server and mcp-server re-export from it.

## Workspace setup scripts
Projects have `setup_script` (nullable text) and `setup_blocking` (boolean, default true) columns. `runSetupScript()` in `@agentic-kanban/shared/lib/setup-script.ts`. Blocking: await script then launch. Parallel: fire-and-forget. Non-fatal. PATCH `/api/projects/:id` updates setup script config.

## Issue numbers
Auto-incrementing per project via `MAX(issue_number) + 1` in `POST /api/issues`. `issue_number` added in migration 0006. The `MIGRATION_FILES` array in `api.test.ts` must include every migration SQL file.

## Review session must inherit claude_profile
When launching auto-review/manual-review from `index.ts`, read `claude_profile` from `prefMap` and pass as 6th arg to `sessionManager.startSession()`. Without it the review agent falls back to `ANTHROPIC_API_KEY` and gets 401. Pattern: `const claudeProfile = useMock ? undefined : (prefMap.get("claude_profile") || undefined);`

## Session summary endpoint
`GET /api/sessions/:id/summary` parses JSONL stream events into structured summary (files read/edited/written, commands, excerpts, errors, model, duration). No LLM call — pure server-side parsing in `parseSessionSummary()` in `sessions.ts`.

## Shared package must be rebuilt after schema changes
`@agentic-kanban/shared` consumed via compiled `dist/` output. `tsx watch` does NOT rebuild the shared package. After adding columns to `packages/shared/src/schema/*.ts`, run `pnpm --filter @agentic-kanban/shared build` before restarting server.

## Butler (warm Claude Agent SDK session)

The project butler is a persistent, warm Claude assistant — **not** the CLI-spawn
agent model used for board tasks. It runs in-process via the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`), one warm session per project.

- `butler-sdk.service.ts` owns a `Map<projectId, ButlerSession>`. Each session
  feeds turns into a single `query({ prompt: AsyncIterable<SDKUserMessage> })` via
  a `Pushable` queue, so conversation context stays warm in-process across turns
  (no `--resume` respawn). Token deltas are emitted as `ButlerEvent`s to listeners.
- **Why SDK, not CLI:** keeping a CLI `claude.exe` warm with stdin open does not
  stream on Windows (it buffers stdout until stdin closes). The SDK is a library
  call with a native async iterator — no stdio/TTY buffering, true streaming.
- **Auth/model:** reuse the active Claude profile env via `buildSpawnEnv(profile)`
  (`options.env`), so the butler authenticates the same way as the rest of the app
  (CLI login / API key / Bedrock). Verified working with the `anth` profile.
- **Routes** (`butler.ts`, mounted under `/projects`): `POST /:id/butler/ensure`
  (start warm session), `POST /:id/butler/message` (push a turn), `GET
  /:id/butler/stream` (SSE of `ButlerEvent`s), `DELETE /:id/butler` (stop). The
  SDK `session_id` is persisted to preference `butler_session_<projectId>` and
  passed as `resume` on next ensure, so the butler survives server restarts.
- `permissionMode: "bypassPermissions"` (+ `allowDangerouslySkipPermissions`) —
  there is no human in the chat loop to approve tool prompts.

**Caution — worktree DB resolution:** a git worktree has no `packages/server/kanban.db`
(the file is gitignored, so it is never checked out into a fresh worktree). `data-dir.ts`
resolves the DB by file existence, so a worktree dev server finds no local db and falls
through to `~/.agentic-kanban/kanban.db` — a *separate* database from the main checkout,
with its own projects/IDs. A worktree server therefore runs against **different data**
than the main board, not the main DB (there is no shared file, hence no lock contention).
To point a worktree server at a specific DB, set `AGENTIC_KANBAN_DIR` or `DB_URL`.
