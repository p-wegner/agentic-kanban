# Server Package — Architecture Patterns

## Circular imports
Route modules that need services (e.g., `sessionManager`) should receive them via factory functions or lazy getters, not direct imports from `index.ts`.

## MCP server DB path
Uses `import.meta.dirname` relative path (`../../server/kanban.db`) since pnpm changes CWD per package. Scripts using `import.meta.dirname` from `packages/server/src/scripts/` must account for depth — `../../../kanban.db` points to repo root, not the actual DB.

## WebSocket setup
`@hono/node-ws` requires `createNodeWebSocket({ app })` then `injectWebSocket(server)` after `serve()` returns.

## Test agent substitution
`AGENT_COMMAND` env var overrides the agent binary for E2E tests; `MOCK_AGENT=1` globally enables mock agent; `mock_agent` preference stores per-user setting in DB. Mock agent must use `pathToFileURL()` to resolve absolute path to `packages/server/node_modules/tsx/dist/loader.mjs` as a `file://` URL in `--import` — bare `--import tsx` fails with `ERR_MODULE_NOT_FOUND`.

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
`createWorktree()` accepts optional `baseBranch`. When creating new branch, runs `git branch <branch> <baseBranch>` instead of defaulting to HEAD. Both git services must be kept in sync (`packages/server/src/services/git.service.ts` and `packages/mcp-server/src/git-service.ts` are duplicates).

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
