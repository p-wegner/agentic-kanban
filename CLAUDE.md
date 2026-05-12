# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status
This project is **Stage 13 complete** (Stages 0-13 done). Tech stack: TypeScript monorepo — Hono + Drizzle + React + MCP SDK. Progress tracked in `docs/state.md`.

All documented features have been visually verified (2026-05-12):
- Board renders 3 active columns (Todo, In Progress, In Review) with collapsible "Completed" group for Done/Cancelled
- Create issue: inline form with title, description, priority, Add/Cancel
- Issue detail panel: slide-in with view/edit/delete, status dropdown, description placeholder, priority badge, status, workspaces, tags, timestamps, issue number
- Edit issue: title/description/priority editable, Save/Cancel; all sections visible in edit mode; unsaved changes warning
- Tags: CRUD via dropdown in detail panel, removable badges with colors, 4 seed tags (bug, feature, improvement, docs)
- Search/filter: real-time text search with highlighted matches, priority dropdown filter, keyboard shortcut `/` to focus, Escape to clear
- Drag-and-drop: HTML5 DnD between columns (mouse-based, use `run-code` for `/` key on Windows/MSYS)
- Workspace panel: slide-in with read-only repo info, "New Workspace" button (one-step: creates worktree + auto-launches agent with issue title/description as prompt), delete button with confirmation for active and closed workspaces
- Worktree overview: branch icon in header, slide-in panel listing all git worktrees with issue linking, diff stats, and status badges
- Project switcher: dropdown in header when multiple projects registered
- API routes: health, projects (with git info + worktrees), preferences (active-project + settings), board aggregation, issues (CRUD), workspaces (CRUD + one-step create with worktree+launch + actions), tags (CRUD), sessions (WebSocket + output history)
- Settings panel: gear icon in header, agent command/args, output parsing, mock agent toggle
- Session history: inline session selector in workspace panel, click between past sessions without leaving workspace context
- Chat-like agent interaction: persistent chat input with Send/Stop toggle, --resume support, auto-clear on exit, Ctrl+Enter to send
- Real-time board updates: board auto-refreshes via WebSocket when mutations happen
- Command palette: Ctrl+K searchable action list, keyboard navigation
- Keyboard shortcut help: `?` overlay showing all shortcuts
- Issue numbers: auto-incrementing #1, #2, #3 per project on cards and detail panel
- Panel animations: slide-in transitions on detail/workspace/settings/worktree panels
- Favicon: inline SVG kanban-board icon
- MCP server: 8 tools via stdio JSON-RPC
- CLI: `pnpm cli -- register <path>` to register a git repo as a project

## What This Is
Cleanroom reimplementation of [vibe-kanban](https://github.com/BloopAI/vibe-kanban) — a kanban board for managing AI-driven coding tasks. Personal use only, single user, local-first. The original (being sunset) is 34 Rust crates; we're building a focused alternative.

## Key Constraints
- **Claude Code only** as the AI agent (no multi-agent support)
- **Local only** — no cloud, no multi-tenant, no OAuth
- **Testability first** — E2E tests from day one, AI-runnable feedback loops
- **Tech stack TBD** — resolved: TypeScript (Hono + Drizzle + React + MCP SDK)
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
- **Hook paths on Windows**: Use relative paths (`.claude/hooks/...`) not `$CLAUDE_PROJECT_DIR` (env var not expanded) or absolute paths (not portable)
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
- **Inline session switching**: Replaced full-panel history overlay with inline session selector inside expanded workspace. `selectedHistoryId` state tracks which past session is being viewed. Session selector shows "Latest" tab + clickable past session rows (status, time, duration). Clicking a past session loads its output into the same TerminalView area. Chat input and action buttons hide during history viewing. Escape dismisses history selection before closing panel.
- **Workspace creation (one-step)**: `POST /api/workspaces` does everything: resolves issue → project → repoPath, creates git worktree (with optional `baseBranch`), inserts DB record with `workingDir` and `baseBranch`, then auto-launches agent. The `createWorkspacesRoute` receives `getSessionManager` and `boardEvents` via factory options. Error handling: if worktree/launch fails, still returns 201 with the workspace record and `error` field.
- **Direct workspaces**: When `isDirect: true` in the POST body, no worktree is created — `workingDir` is set to the project's `repoPath` and `branch` is auto-detected via `gitService.getCurrentBranch()`. The `baseBranch` is null for direct workspaces. Diff uses `git diff HEAD` (working tree changes) instead of `git diff <baseBranch>`. Merge is a no-op (just closes the workspace). The UI shows a checkbox "Work directly on main checkout" that hides branch/base fields. Direct workspaces show a purple "direct" badge and use "Close" instead of "Merge" and "View Changes" instead of "View Diff".
- **Session resume chain**: Claude's internal `session_id` is captured from `system/init` stream-json events in `session.manager.ts` broadcast() and stored in `sessions.claudeSessionId`. On relaunch, `resumeFromId` looks up the previous session's `claudeSessionId` and passes `--resume <id>` to the agent.
- **Mock agent tsx resolution**: The mock agent runs from the worktree CWD (no `node_modules`). It must use `pathToFileURL()` to resolve the absolute path to `packages/server/node_modules/tsx/dist/loader.mjs` as a `file://` URL in the `--import` flag. Bare `--import tsx` would fail with `ERR_MODULE_NOT_FOUND`.
- **Branch suggestion/listing**: The workspace creation form auto-suggests a branch name via `suggestBranchName()` (format: `feature/<issue-number>-<sanitized-title>`). The `sanitizeBranchName()` function lowercases, replaces non-alphanumeric chars with hyphens, collapses runs, and limits to 80 chars. Base branch uses a `<select>` dropdown populated from `GET /api/projects/:id/branches` (calls `listBranches()` in git service), with "Default (main)" as the first option. Falls back to text input if the branches API fails.
- **Git worktree base branch**: `createWorktree()` in both server and MCP git services accepts an optional `baseBranch` parameter. When creating a new branch, it runs `git branch <branch> <baseBranch>` instead of `git branch <branch>` (which defaults to HEAD). This ensures worktrees start from the correct base.
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
- **Collapsible column groups**: The board splits columns into "active" (Todo, In Progress, In Review) and "archive" (Done, Cancelled) groups based on `ARCHIVE_STATUS_NAMES` set (name-based, not ID-based — no schema changes needed). Archive group renders as a collapsed bar with per-column counts; click to expand inline. Layout is `flex-col` vertical stacking with each group having its own `flex gap-4 overflow-x-auto` row. The `ColumnGroup` component accepts the same `BoardColumn` props plus `collapsed`/`onToggle`. E2E tests must scope "Cancel" locators carefully — the collapsed bar text "Cancelled" matches `button:has-text("Cancel")`, causing strict mode violations. Use `form.locator(...)` scoping or regex `/^Cancel$/` exact match.

## Visual Verification
Every feature that has a UI component must be visually verified using the `playwright-cli` skill (user-scoped). After implementing or modifying a feature:
1. Ensure dev servers are running (`pnpm dev`)
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

## Monorepo Commands
- `pnpm dev` — start server (port 3001) + client (port 5173) concurrently
- `pnpm --filter @agentic-kanban/server test` — Vitest unit tests (28 tests)
- `pnpm test:e2e` — Playwright E2E tests (60 tests)
- `pnpm --filter @agentic-kanban/mcp-server dev` — run MCP server for testing
- `pnpm db:migrate && pnpm db:seed` — initialize DB (apply migrations + seed tags)
- `pnpm db:reset` — wipe and recreate DB from scratch (deletes kanban.db, re-migrates, re-seeds; stop dev server first)
- `pnpm cli -- register <path>` — register a git repo as a project
- `pnpm cli -- list` — list registered projects
- `pnpm cli -- unregister <name>` — remove a project by name or ID
- `pnpm cli -- cleanup` — show stale worktrees for closed workspaces

## Getting Started (First Run)
1. `pnpm install` — install dependencies
2. `pnpm db:migrate && pnpm db:seed` — initialize database (creates 4 default tags)
3. `pnpm cli -- register <repo-path>` — register a git repo as a project (auto-detects default branch and remote URL)
4. `pnpm dev` — start the app
5. Open `http://localhost:5173` — board loads with the registered project's columns

## Project Registration
Each project maps 1:1 to a git repo. The CLI reads git info automatically:
- **repoPath**: resolved to absolute path
- **repoName**: directory basename
- **defaultBranch**: detected from `symbolic-ref refs/remotes/origin/HEAD`, falls back to `init.defaultBranch`, then `"main"`
- **remoteUrl**: from `git remote get-url origin` (nullable — works without remote)

The registered project gets 5 default statuses (Todo, In Progress, In Review, Done, Cancelled) and is set as the active project. Registering additional projects adds a dropdown switcher in the header.

## Workspace Flow
Workspaces are created in a single step: `POST /api/workspaces` accepts `issueId`, `branch`, and optional `baseBranch` (defaults to project's `defaultBranch`). The server creates the DB record, creates the git worktree, and auto-launches the agent with the issue title + description as the prompt. The response includes `sessionId` so the client can immediately show terminal output.

- `POST /api/workspaces` — one-step: DB record + worktree + auto-launch agent
- `POST /api/workspaces/:id/setup` — legacy no-op if worktree already exists (backward compat)
- `GET /api/workspaces/:id/diff` — diffs against `workspace.baseBranch` (falls back to project's `defaultBranch`)
- `POST /api/workspaces/:id/merge` — merges into project's `defaultBranch`
- `DELETE /api/workspaces/:id` — cascade-deletes session messages, sessions, then workspace

The `baseBranch` column on the workspaces table tracks which branch the worktree was created from, ensuring diff/merge use the correct base even if the project's default branch changes later.

## MVP Core Loop
Register repo (`pnpm cli -- register <path>`) → Create issue → Click "New Workspace" (one step: branch + worktree + agent launch) → View diff → Merge

## Reference Codebase
The original vibe-kanban is at `F:/projects/vibe-kanban` for reference. Key files:
- `crates/mcp/src/task_server/` — MCP tool definitions
- `crates/db/migrations/` — database schema evolution
- `crates/api-types/src/` — shared type definitions
- `shared/types.ts` — generated TypeScript types
