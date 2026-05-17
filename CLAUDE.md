# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status
This project is **Stage 13 complete + Tauri desktop** (Stages 0-13 done). Tech stack: TypeScript monorepo — Hono + Drizzle + React + MCP SDK + Tauri v2. Progress tracked in `docs/state.md`.

All documented features have been visually verified (2026-05-16):
- Board renders 3 active columns (Todo, In Progress, In Review) with collapsible "Completed" group for Done/Cancelled
- Create issue: inline form with title, description, priority, plan mode, skip review, Add/Cancel; expandable full-screen panel via Expand button
- Issue detail panel: slide-in with view/edit/delete, status dropdown, description placeholder, priority badge, status, workspaces, tags, timestamps, issue number
- Edit issue: title/description/priority editable, Save/Cancel; all sections visible in edit mode; unsaved changes warning
- Tags: CRUD via dropdown in detail panel, removable badges with colors, 4 seed tags (bug, feature, improvement, docs)
- Search/filter: real-time text search with highlighted matches, priority dropdown filter, keyboard shortcut `/` to focus, Escape to clear
- Drag-and-drop: HTML5 DnD between columns (mouse-based, use `run-code` for `/` key on Windows/MSYS)
- Workspace panel: slide-in with read-only repo info, "New Workspace" button (one-step: creates worktree + auto-launches agent with issue title/description as prompt), delete button with confirmation for active and closed workspaces
- Worktree overview: branch icon in header, slide-in panel listing all git worktrees with issue linking, diff stats, and status badges
- Project switcher: dropdown in header when multiple projects registered
- API routes: health, projects (with git info + worktrees), preferences (active-project + settings), board aggregation, issues (CRUD), workspaces (CRUD + one-step create with worktree+launch + actions), tags (CRUD), sessions (WebSocket + output history)
- Settings panel: tabbed modal (gear icon in header), agent command/args, output parsing, mock agent toggle, auto_merge, review_auto_fix, claude_profile
- Session history: inline session selector in workspace panel, click between past sessions without leaving workspace context
- Chat-like agent interaction: persistent chat input with Send/Stop toggle, --resume support, auto-clear on exit, Ctrl+Enter to send, multi-turn follow-up messages via stdin JSONL, turn state tracking (processing/waiting), "Turn complete — waiting for input" display
- AI code review: auto-review on agent session exit (configurable per-issue), manual review button, reviewing indicator badge, review sessions inherit claude_profile, auto_fix setting
- Live session stats: real-time model name and context token count on issue cards via WebSocket
- Real-time board updates: board auto-refreshes via WebSocket when mutations happen
- Command palette: Ctrl+K searchable action list, keyboard navigation
- Keyboard shortcut help: `?` overlay showing all shortcuts
- Issue numbers: auto-incrementing #1, #2, #3 per project on cards and detail panel
- Panel animations: slide-in transitions on detail/workspace/settings/worktree panels
- Favicon: inline SVG kanban-board icon
- MCP server: 27 tools via stdio JSON-RPC (includes agent skills: list/get/create/export, get_board_status)
- CLI: `pnpm cli -- register <path>` to register a git repo as a project; also `issue list/create/move`, `workspace list/create`, `skill list/get/create`, and `status` for board overview
- Agent skills: 4 built-in skills (board-navigator, code-review, dependency-analyzer, ticket-enhancer) + custom skills via DB. Skills are prompt templates injected into agent context at workspace creation time. Skills can be global or project-scoped.
- Desktop app: Tauri v2 native window with system tray (Show/Quit), minimize-to-tray on close, OS notifications on session_completed/workspace_merged events
- Workspace setup scripts: project-specific shell commands (e.g., `pnpm install`) that run automatically after worktree creation. Configurable in Settings > Project tab with AI-generate button. Supports blocking (wait for setup before agent) and parallel modes.

## What This Is
Cleanroom reimplementation of [vibe-kanban](https://github.com/BloopAI/vibe-kanban) — a kanban board for managing AI-driven coding tasks. Personal use only, single user, local-first. The original (being sunset) is 34 Rust crates; we're building a focused alternative.

## Key Constraints
- **Claude Code only** as the AI agent (no multi-agent support)
- **Local only** — no cloud, no multi-tenant, no OAuth
- **Testability first** — E2E tests from day one, AI-runnable feedback loops
- **Tech stack TBD** — resolved: TypeScript (Hono + Drizzle + React + MCP SDK)
- **Server resilience**: Agent subprocess callbacks are wrapped in try/catch in `agent.service.ts` — a failing agent never crashes the server. `uncaughtException`/`unhandledRejection` handlers log with `[fatal]` prefix before exiting. Stale sessions (still "running" after crash/restart) are cleaned up on startup in `index.ts` after migrations — set to "stopped" and their workspaces to "idle".
- **PR creation is skipped** — manual merge only
- **Always commit** — after finishing a task, commit the changes without waiting to be asked
- Use `uv` and `uv venv` for any Python work (never global site-packages)
- Windows environment

## Architecture Patterns
- **Avoid circular imports**: Route modules that need services (e.g., `sessionManager`) should receive them via factory functions or lazy getters, not direct imports from `index.ts`
- **MCP server DB path**: Uses `import.meta.dirname` relative path (`../../server/kanban.db`) since pnpm changes CWD per package
- **Git tests on Windows**: Use `.trim()` for file content assertions (CRLF vs LF); test git output for keywords, not exact strings
- **WS setup**: `@hono/node-ws` requires `createNodeWebSocket({ app })` then `injectWebSocket(server)` after `serve()` returns
- **Test agent substitution**: `AGENT_COMMAND` env var overrides the agent binary for E2E tests; `MOCK_AGENT=1` env var globally enables mock agent for all launches; `mock_agent` preference stores per-user setting in DB
- **Adding settings keys**: The preferences route uses a whitelist pattern — new settings require adding the key to both the GET `keys` array and PUT `allowedKeys` array in `packages/server/src/routes/preferences.ts`. The client `SettingsPanel.tsx` also needs the key added to its `Settings` interface and `DEFAULT_SETTINGS` object.
- **Hook paths on Windows**: Use **forward slashes** in `settings.json` hook commands. Double-backslash escaping (`\\`) gets mangled by Claude Code's hook runner, producing `MODULE_NOT_FOUND` errors. Forward slashes work correctly with Node.js on Windows. Example: `"node C:/andrena/agentic-kanban/.claude/hooks/smart-hooks-runner.js Stop"`. Relative paths like `.claude/hooks/...` also fail when Claude Code's CWD shifts (e.g., when working in a package subdirectory). `$CLAUDE_PROJECT_DIR` is not expanded in hook command strings.
- **E2E locator specificity**: `page.locator("text=X")` can match multiple elements (labels, descriptions) causing strict mode violations. Use scoped selectors: `page.locator("label", { hasText: "X" })` or `.first()`
- **E2E test data cleanup**: Use `test.afterAll` to reset preferences/settings state; accumulate-only test data (issues from prior runs) can cause duplicate text matches in unrelated tests. Hardcoded edited titles (e.g. `"Edited Title 777"`) accumulate across runs — use `Date.now()` suffixes. Known flaky test: `board.test.ts` "edit issue from detail panel" fails due to this.
- **Pre-existing test failures**: Never dismiss failing tests as "pre-existing" without investigating. At minimum, determine root cause (data accumulation, race condition, API change) and assess fix complexity. Fix if straightforward; document as known issue if not.
- **Board API data enrichment**: Workspace summaries are computed server-side in the board endpoint via a single grouped query, then attached to each issue as `workspaceSummary`. This eliminates the need for client-side state tracking (like `issuesWithWorkspaces` Set). Prefer server-side aggregation over client-side joins.
- **E2E session/workspace tests**: Workspace `setup` (git worktree creation) and session message persistence can be flaky. Use retry loops (3 attempts, 500ms–1s delays) for both setup and output fetching instead of `test.skip()`. Setup retries go in `beforeAll`; output retries wrap the GET request. Avoid `test.skip()` unless there is truly no alternative.
- **Board events (dual path)**: WS `/ws/board/:projectId` broadcasts `board_changed` events for fast same-server updates. A 30s polling fallback in `useBoardEvents` catches mutations from MCP, CLI, second tabs, or WS failures. MCP tools call `notifyBoard()` (fire-and-forget `POST /api/internal/board-notify`) for instant updates instead of waiting for the next poll cycle. Server-side board events service (`board-events.ts`) is passed to routes via factory options. Session manager's `onSessionExit` callback triggers board broadcast via projectId resolution.
- **Session messages**: All agent output is persisted to `session_messages` table (fire-and-forget insert in `broadcast()`). Retrieved via `GET /api/sessions/:id/output`.
- **Command palette**: Actions registered via `registerAction()` in `actions.ts`. BoardPage registers actions in `useEffect` with cleanup. Ctrl+K intercepted via `window` keydown listener (Playwright can't send Ctrl+K directly — Chromium intercepts it for address bar focus). E2E tests dispatch via `page.evaluate(() => window.dispatchEvent(...))`.
- **Route factory options**: Routes that need board events or session manager receive `{ boardEvents }` via options object and `getSessionManager` via argument. The `createRoutes` function in `routes/index.ts` passes both to `createWorkspacesRoute` and `createWorkspaceActionsRoute`. The internal `POST /api/internal/board-notify` route also uses `options.boardEvents` to broadcast — it lives inside `createRoutes` so it can access the same boardEvents instance.
- **Chat-like agent UI**: WorkspacePanel uses `isRunning` derived from activeSession + exit message detection (not WS state). TerminalView persists via `completedMessages` state after session ends. `lastSessionPerWorkspace` tracks session IDs for `--resume` chains. Auto-clear `activeSession` on agent exit via useEffect watching messages array. On workspace creation, `activeSession` is set from the POST response's `sessionId` to show terminal output immediately.
- **Re-chat and agent stdout**: On Windows, `claude.exe` buffers stdout until stdin is closed. The agent service always uses `stdin.end(prompt)` (never `stdin.write()` with stdin left open). Each re-chat message spawns a new process with `--resume <claudeSessionId>`. The `stdinOpen` map and `sendInput`/`closeStdin`/`isStdinOpen` functions remain for future multi-turn re-implementation. Graceful stop: `closeStdin()` → 2s wait → `kill()`. The `stoppedByUser` set prevents the exit handler from overwriting the DB status set by `stopSession`.
- **Inline session switching**: Replaced full-panel history overlay with inline session selector inside expanded workspace. `selectedHistoryId` state tracks which past session is being viewed. Session selector shows "Latest" tab + clickable past session rows (status, time, duration). Clicking a past session loads its output into the same TerminalView area. Chat input and action buttons hide during history viewing. Escape dismisses history selection before closing panel.
- **Workspace creation (one-step)**: `POST /api/workspaces` does everything: resolves issue → project → repoPath, creates git worktree (with optional `baseBranch`), inserts DB record with `workingDir` and `baseBranch`, then auto-launches agent. The `createWorkspacesRoute` receives `getSessionManager` and `boardEvents` via factory options. Error handling: if worktree/launch fails, still returns 201 with the workspace record and `error` field.
- **Direct workspaces**: When `isDirect: true` in the POST body, no worktree is created — `workingDir` is set to the project's `repoPath` and `branch` is auto-detected via `gitService.getCurrentBranch()`. The `baseBranch` is null for direct workspaces. Diff uses `git diff HEAD` (working tree changes) instead of `git diff <baseBranch>`. Merge is a no-op (just closes the workspace). The UI shows a checkbox "Work directly on main checkout" that hides branch/base fields. Direct workspaces show a purple "direct" badge and use "Close" instead of "Merge" and "View Changes" instead of "View Diff".
- **Session resume chain**: Claude's internal `session_id` is captured from `system/init` stream-json events in `session.manager.ts` broadcast() and stored in `sessions.claudeSessionId`. On relaunch, `resumeFromId` looks up the previous session's `claudeSessionId` and passes `--resume <id>` to the agent.
- **Mock agent tsx resolution**: The mock agent runs from the worktree CWD (no `node_modules`). It must use `pathToFileURL()` to resolve the absolute path to `packages/server/node_modules/tsx/dist/loader.mjs` as a `file://` URL in the `--import` flag. Bare `--import tsx` would fail with `ERR_MODULE_NOT_FOUND`.
- **Branch suggestion/listing**: The workspace creation form auto-suggests a branch name via `suggestBranchName()` (format: `feature/ak-<issue-number>-<sanitized-title>`). The `sanitizeBranchName()` function lowercases, replaces non-alphanumeric chars with hyphens, collapses runs, and limits to 80 chars. Base branch uses a `<select>` dropdown populated from `GET /api/projects/:id/branches` (calls `listBranches()` in git service), with "Default (main)" as the first option. Falls back to text input if the branches API fails.
- **Git worktree base branch**: `createWorktree()` in both server and MCP git services accepts an optional `baseBranch` parameter. When creating a new branch, it runs `git branch <branch> <baseBranch>` instead of `git branch <branch>` (which defaults to HEAD). This ensures worktrees start from the correct base.
- **Workspace setup scripts**: Projects have `setup_script` (text, nullable) and `setup_blocking` (boolean, default true) columns. When a workspace is created, if the project has a setup script, it runs in the worktree directory via `runSetupScript()` (in `@agentic-kanban/shared/lib/setup-script.ts`). Blocking mode: await script, then launch agent. Parallel mode: fire-and-forget script, launch agent immediately. Setup failure is non-fatal. The UI is in Settings > Project tab with a "Generate with AI" button (same `spawnSync` pattern as `/api/issues/enhance`). The PATCH `/api/projects/:id` endpoint updates project fields including setup script config.
- **DB file locations**: The server DB lives at `packages/server/kanban.db` (relative to `file:kanban.db` CWD resolution under pnpm). The MCP server has its own copy at `packages/mcp-server/kanban.db`. Scripts using `import.meta.dirname` relative paths must account for which package they run in — `../../../kanban.db` from `packages/server/src/scripts/` points to the repo root, not the actual DB.
- **Issue numbers**: Auto-incrementing per project via `MAX(issue_number) + 1` in `POST /api/issues`. The `issue_number` column was added in migration 0006. The test migration list in `api.test.ts` (`MIGRATION_FILES` array) must be updated when new migrations are added.
- **`/` key search shortcut**: `e.preventDefault()` on keydown doesn't prevent the subsequent input event from inserting the character. Fix: use `requestAnimationFrame` to clear the stray `/` from the input after focus shift.
- **Board refresh during create form**: WebSocket board_changed events can unmount the inline create form mid-edit. Fix: skip board refreshes while `creatingInColumnId` is set, queue a pending refresh via ref, and process it when the form closes.
- **Panel state sync**: `selectedIssue` in BoardPage is a snapshot captured on click. Board refreshes don't update the open panel. Fix: a `useEffect` watches `columns` changes and re-finds the issue by ID, updating `selectedIssue` in place. If the issue was deleted, the panel closes.
- **Panel stays open after save**: The old pattern closed the detail panel on every `handleUpdateIssue`. Fix: remove `setSelectedIssue(null)` from the update handler — the useEffect above re-syncs the data. Add `onIssueUpdate` prop if the panel needs to push updates upstream.
- **Unsaved changes guard**: Use a `hasChanges` derived boolean (compare local edit state against `issue` prop) and `window.confirm()` in backdrop click, close button, Escape, and Cancel handlers. This is simpler than a router-level prompt for modal/panel patterns.
- **Search result highlighting**: Pass `searchQuery` through `BoardColumn` → `IssueCard` props. The `HighlightedText` component splits text at the first match index and wraps the match in a `<mark>` element. Only highlights the first occurrence to avoid complex multi-match rendering.
- **Slide-in animations**: Defined in `app.css` as `@keyframes slide-in-right` with `transform: translateX(100%) → 0`. Applied via `animate-slide-in-right` class on panel containers. 0.2s ease-out duration feels snappy without being jarring.
- **Migration test list**: The `MIGRATION_FILES` array in `packages/server/src/__tests__/api.test.ts` must include every migration SQL file. Forgetting to add new migrations here causes test failures (missing columns).
- **Migration journal required**: Every new `packages/shared/drizzle/NNNN_name.sql` file must also have a matching entry added to `packages/shared/drizzle/meta/_journal.json`. Without the journal entry, `drizzle-kit migrate` silently skips the SQL file — the migration reports success but the column is never added, causing runtime `SQLITE_ERROR: no such column` errors. See `.llm/workflows.md` for the full diagnosis and fix workflow.
- **Migration statement-breakpoint**: Multi-statement SQL files (e.g. two `ALTER TABLE ADD` in one migration) require `--> statement-breakpoint` between each statement. Without it, drizzle-kit only executes the first statement and silently skips the rest. Always check existing multi-statement migrations for the marker pattern.
- **Migration journal timestamps must be monotonic**: Drizzle orders migrations by the `when` field in `_journal.json`. If a later migration has an earlier timestamp than the initial schema creation, drizzle runs it first — `ALTER TABLE` statements fail silently because the table doesn't exist yet. Always use timestamps later than the previous entry.
- **Direct workspace diff only shows tracked files**: `git diff HEAD` excludes untracked files. For direct workspaces, `getWorkingTreeDiff()` also runs `git ls-files --others --exclude-standard` to surface new files created by the agent.
- **Collapsible column groups**: The board splits columns into "active" (Todo, In Progress, In Review) and "archive" (Done, Cancelled) groups based on `ARCHIVE_STATUS_NAMES` set (name-based, not ID-based — no schema changes needed). Archive group renders as a collapsed bar with per-column counts; click to expand inline. Layout is `flex-col` vertical stacking with each group having its own `flex gap-4 overflow-x-auto` row. The `ColumnGroup` component accepts the same `BoardColumn` props plus `collapsed`/`onToggle`. E2E tests must scope "Cancel" locators carefully — the collapsed bar text "Cancelled" matches `button:has-text("Cancel")`, causing strict mode violations. Use `form.locator(...)` scoping or regex `/^Cancel$/` exact match.
- **Review session must inherit claude_profile**: When launching auto-review or manual-review sessions from `index.ts`, always read `claude_profile` from `prefMap` and pass it as the 6th argument to `sessionManager.startSession()`. Without it the review agent falls back to `ANTHROPIC_API_KEY` directly and gets a 401 even when the primary agent works fine via a gateway settings file. Pattern: `const claudeProfile = useMock ? undefined : (prefMap.get("claude_profile") || undefined);` then `startSession(wsId, prompt, agentCommand, agentArgs, undefined, claudeProfile)`.
- **Workspace panel status guards**: UI sections in `WorkspacePanel.tsx` that gate on `ws.workingDir && ws.status !== "closed"` hide all content for auto-merged workspaces (which set `workingDir: null` and `status: "closed"`). Session history, TerminalView, and session stats should be shown for closed workspaces too — only the chat footer and action buttons (Review, Merge, etc.) should stay gated on `ws.status !== "closed"`.
- **Client tsconfig excludes test files**: The client's `tsconfig.json` uses `"include": ["src"]` which picks up `*.test.ts` files. These import `vitest` which is not a declared type dep for the production build, causing `tsc -b` to fail. Always include `"exclude": ["src/**/*.test.ts", "src/**/*.test.tsx"]` in `packages/client/tsconfig.json`.
- **Detached HEAD guard in worktrees**: Git rebase and other operations can leave worktrees in detached HEAD state — agent commits then go to no branch and merges become no-ops. `syncBranchToHead()` in `git.service.ts` (both server and MCP) forces the branch ref to match HEAD before every merge. `ensureOnBranch()` reattaches HEAD after worktree creation and successful rebase. Both git services (`packages/server/src/services/git.service.ts` and `packages/mcp-server/src/git-service.ts`) are duplicates and must be kept in sync. When adding git operations to either, always update both.
- **Session summary endpoint**: `GET /api/sessions/:id/summary` parses raw JSONL stream events from `session_messages` into a structured summary (files read/edited/written, commands run, agent text excerpts, errors, model, duration, stats). No LLM call — pure server-side parsing. The `parseSessionSummary()` function in `packages/server/src/routes/sessions.ts` handles multi-line JSONL in a single data field, skips stderr, and caps excerpts at 10 / 300 chars. The WorkspacePanel shows an Output/Summary toggle when viewing past sessions.

## Visual Verification
Every feature that has a UI component must be visually verified using the `playwright-cli` skill (user-scoped). After implementing or modifying a feature:
1. Ensure dev servers are running (`pnpm dev` — use the port from the dev banner, not hardcoded ports)
2. Use `/playwright-cli` to open the page, take a snapshot, and confirm the UI renders correctly
3. Take a screenshot only when needed for debugging — clean up `.png` files and `.playwright-cli/` after
4. Clean up any test data created during verification (full reset: stop server, `pnpm db:reset`, `pnpm cli -- register .`, `pnpm dev`)

## Documentation Map
- @.llm/workflows.md — dev workflows: clean-start setup, DB reset, project registration
- `docs/prd/00-executive-summary.md` — vision, keep/skip list
- `docs/prd/05-mvp-scope.md` — MVP definition, 6-stage plan, feature matrix
- `docs/prd/03-data-model.md` — core entities (Project, Issue, Workspace, Session)
- `docs/prd/04-agent-integration.md` — MCP tools, agent lifecycle
- `docs/prd/06-testability-strategy.md` — test pyramid, per-stage test plans
- `docs/decisions/` — numbered decision records
- `docs/diary.md` — session log for talk/presentation material
- `docs/state.md` — current progress tracking (API routes, MCP tools, stage checklists)

## Board Operations: Prefer MCP Tools or CLI over REST

### `#N` means kanban issue, not GitHub PR

When the user references `#N` (e.g., "review #70", "merge #65", "what's the status of #72"), this **always refers to a kanban board issue number**, never a GitHub pull request. This project does not use PRs — merges are done directly from worktree branches.

- **"review #N"** → invoke the `/kanban-workflow` skill, then use MCP tools to find issue #N, get its workspace diff, review the changes, and merge if acceptable
- **"merge #N"** → same as "review #N and merge"
- **"status of #N"** → use `get_board_status` or `get_issue` to look up issue #N by `issueNumber`

### MCP Tools are the primary interface

When performing kanban board operations (creating issues, moving issues, managing workspaces, etc.), **always prefer the agentic-kanban MCP tools** (`mcp__agentic-kanban__*`) over direct REST API calls via curl. The MCP tools are the intended interface and are always available in Claude Code sessions when the MCP server is configured.

**Use MCP tools for:**
- `mcp__agentic-kanban__create_issue` — create issues (returns `issueNumber`)
- `mcp__agentic-kanban__list_issues` — list/filter issues by status, priority, tag
- `mcp__agentic-kanban__get_issue` — get issue details including workspaces and dependencies
- `mcp__agentic-kanban__update_issue` / `mcp__agentic-kanban__move_issue` — update status, priority, description
- `mcp__agentic-kanban__start_workspace` — create a git worktree for an issue
- `mcp__agentic-kanban__merge_workspace` — merge a workspace branch and close it
- `mcp__agentic-kanban__get_workspace_diff` — inspect changes before merging
- `mcp__agentic-kanban__get_context` — get project info and issue counts
- `mcp__agentic-kanban__get_board_status` — comprehensive overview: all active agents, workspace state, diff stats, session stats, last output
- `mcp__agentic-kanban__list_tags`, `mcp__agentic-kanban__create_tag` — tag management

**Use the CLI (`pnpm cli -- ...`) when MCP is unavailable:**
- `pnpm cli -- issue list` — list issues for active project
- `pnpm cli -- issue create <title>` — create an issue
- `pnpm cli -- issue move <id> <status>` — move issue to a status
- `pnpm cli -- workspace list` — list workspaces for active project
- `pnpm cli -- workspace create <issueId>` — create a git worktree workspace

**Only fall back to REST API curl** when an operation has no MCP tool or CLI equivalent.

## Monorepo Commands
- `pnpm dev` — start server + client concurrently (auto-detects worktree ports; default: server 3001, client 5173)
- `pnpm dev:desktop` — start server + client + Tauri native window (requires MSVC C++ Build Tools + Rust)
- `pnpm --filter agentic-kanban test` — Vitest unit tests (28 tests)
- `pnpm test:e2e` — Playwright E2E tests (60 tests)
- `pnpm --filter @agentic-kanban/mcp-server dev` — run MCP server for testing
- `pnpm db:migrate && pnpm db:seed` — initialize DB (apply migrations + seed tags)
- `pnpm db:reset` — wipe and recreate DB from scratch (deletes kanban.db, re-migrates, re-seeds; stop dev server first)
- `pnpm cli -- register <path>` — register a git repo as a project
- `pnpm cli -- list` — list registered projects
- `pnpm cli -- status` — show board status overview (agents, workspaces, diff stats, session progress)
- `pnpm cli -- unregister <name>` — remove a project by name or ID
- `pnpm cli -- cleanup` — show stale worktrees for closed workspaces
- `pnpm cli -- issue list` — list issues for active project
- `pnpm cli -- issue create <title>` — create an issue
- `pnpm cli -- issue move <id> <status>` — move issue to a status
- `pnpm cli -- workspace list` — list workspaces for active project
- `pnpm cli -- workspace create <issueId>` — create a workspace
- `pnpm cli -- skill list` — list agent skills (`-p <projectId>` to filter by project)
- `pnpm cli -- skill get <name-or-id>` — show skill details and prompt
- `pnpm cli -- skill create <name>` — create a new agent skill (-d description, -p prompt, -m model, --project <id>)
- `pnpm cli -- skill export <path>` — export skills as Claude Code SKILL.md files (-p project, -n names)

## Worktree Port Strategy
`pnpm dev` uses `scripts/dev.mjs` which auto-detects whether the CWD is a git worktree and assigns deterministic ports:
- **Main checkout**: server 3001, client 5173 (default)
- **Worktree** (branch `feature/<N>-...`): server `3001+N`, client `5173+N`
- **Worktree** (non-standard branch): server `3001+hash`, client `5173+hash`

The script prints a banner showing detected ports, e.g.: `[dev] Worktree detected (feature/2-proper-devserver-setup) — server:3003 client:5175`

**Environment variables available to agents**:
- Set by `scripts/dev.mjs`: `PORT`, `VITE_PORT`, `SERVER_PORT`, `KANBAN_SERVER_PORT`, `KANBAN_CLIENT_PORT`
- Set by `agent.service.ts` (passed to spawned agents): `KANBAN_SERVER_PORT`, `KANBAN_CLIENT_PORT`, `SERVER_PORT`, `PORT`
- Agents should read `KANBAN_SERVER_PORT` / `KANBAN_CLIENT_PORT` to determine their ports

**CRITICAL: Never kill ALL node processes.** Other agents may be running in separate worktrees with their own dev servers. Instead:
- Kill by specific port: `Get-NetTCPConnection -LocalPort <port> | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }`
- Or kill by PID: `Stop-Process -Id <pid> -Force`

## Getting Started (First Run)
1. `pnpm install` — install dependencies
2. `pnpm db:migrate && pnpm db:seed` — initialize database (creates 4 default tags)
3. `pnpm cli -- register <repo-path>` — register a git repo as a project (auto-detects default branch and remote URL)
4. `pnpm dev` — start the app (auto-detects worktree; prints banner with ports)
5. Open the client URL shown in the dev banner (default `http://localhost:5173`, worktrees use different ports)

## Project Registration
Each project maps 1:1 to a git repo. The CLI reads git info automatically:
- **repoPath**: resolved to absolute path
- **repoName**: directory basename
- **defaultBranch**: detected from `symbolic-ref refs/remotes/origin/HEAD`, falls back to `init.defaultBranch`, then `"main"`
- **remoteUrl**: from `git remote get-url origin` (nullable — works without remote)

The registered project gets 5 default statuses (Todo, In Progress, In Review, Done, Cancelled) and is set as the active project. Registering additional projects adds a dropdown switcher in the header.

## Workspace Flow
Workspaces are created in a single step: `POST /api/workspaces` accepts `issueId`, `branch`, optional `baseBranch` (defaults to project's `defaultBranch`), and optional `skillId`. The server creates the DB record, creates the git worktree, and auto-launches the agent with the issue title + description as the prompt. If `skillId` is provided, the skill is written as a SKILL.md file in the worktree for the agent to discover on demand. The response includes `sessionId` so the client can immediately show terminal output.

- `POST /api/workspaces` — one-step: DB record + worktree + auto-launch agent
- `POST /api/workspaces/:id/setup` — legacy no-op if worktree already exists (backward compat)
- `POST /api/workspaces/:id/turn` — send follow-up message to running session (multi-turn), returns 409 if agent still processing
- `GET /api/workspaces/:id/diff` — diffs against `workspace.baseBranch` (falls back to project's `defaultBranch`)
- `POST /api/workspaces/:id/merge` — merges into project's `defaultBranch`
- `DELETE /api/workspaces/:id` — cascade-deletes session messages, sessions, then workspace

The `baseBranch` column on the workspaces table tracks which branch the worktree was created from, ensuring diff/merge use the correct base even if the project's default branch changes later.

## MVP Core Loop
Register repo (`pnpm cli -- register <path>`) → Create issue → Click "New Workspace" (one step: branch + worktree + agent launch) → View diff → Merge

## Agent Skills
Agent skills are prompt templates stored in the `agent_skills` DB table. When a workspace is created with a `skillId`, the skill is written as a `.claude/skills/<name>/SKILL.md` file in the worktree — the agent discovers and invokes it on demand (progressive disclosure), rather than having the full prompt injected upfront. Skills have a `model` override field (e.g., "haiku" for quick tasks). Skills can be **global** (available to all projects) or **project-scoped** (only available to a specific project via `project_id`).

- **Built-in skills**: Seeded on `pnpm db:seed` with `isBuiltin: true`. Cannot be modified or deleted via API. Four defaults: `board-navigator` (comprehensive board interaction guide), `code-review` (default AI code review prompt — customizable per project), `dependency-analyzer` (analyze issue dependencies), `ticket-enhancer` (improve ticket clarity).
- **Custom skills**: Created via API, CLI, or MCP tools. Can be edited and deleted. Support optional `projectId` to scope to a project.
- **Storage**: `agent_skills` table (id, name, description, prompt, model, project_id, is_builtin, timestamps). Referenced by `workspaces.skill_id`. `name` uniqueness is per-scope (global or same project_id).
- **API**: `GET/POST/PUT/DELETE /api/agent-skills` — CRUD with builtin protection. `GET ?projectId=<id>` returns global + project-specific skills. `GET ?global=true` returns only global skills.
- **MCP tools**: `list_agent_skills` (optional `projectId` filter), `get_agent_skill`, `create_agent_skill` (optional `projectId`), `export_agent_skills`.
- **CLI**: `pnpm cli -- skill list/get/create/export`. `list -p <projectId>` filters by project. `create --project <id>` scopes to project. `export <path>` writes SKILL.md files to `.claude/skills/`.
- **UI**: Skills tab in Settings panel for management; skill selector dropdown in workspace creation form (filtered by current issue's project).
- **Review prompt**: The code review workflow uses a built-in `code-review` skill as its prompt template. Users can create a custom `code-review` skill scoped to their project to override review behavior. The template supports `{{branch}}`, `{{baseBranch}}`, `{{issueId}}`, and `{{autoFixInstructions}}` placeholders.
- **Export**: The `export_agent_skills` MCP tool and `pnpm cli -- skill export <path>` write skills as Claude Code's native `.claude/skills/<name>/SKILL.md` format with frontmatter, making them available to Claude Code in the terminal for any project.

## Reference Codebase
The original vibe-kanban is at `F:/projects/vibe-kanban` for reference. Key files:
- `crates/mcp/src/task_server/` — MCP tool definitions
- `crates/db/migrations/` — database schema evolution
- `crates/api-types/src/` — shared type definitions
- `shared/types.ts` — generated TypeScript types
