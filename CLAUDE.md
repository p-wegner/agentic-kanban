# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status
This project is **Stage 8 complete** (Stages 0-8 done). Tech stack: TypeScript monorepo — Hono + Drizzle + React + MCP SDK. Progress tracked in `docs/state.md`.

All documented features have been visually verified (2026-05-02):
- Board renders 5 columns (Todo, In Progress, In Review, Done, Cancelled) with empty states
- Create issue: inline form with title, description, priority, Add/Cancel
- Issue detail panel: slide-in with view/edit/delete, description, priority badge, status, workspaces, tags
- Edit issue: title/description/priority editable, Save/Cancel
- Tags: CRUD via dropdown in detail panel, removable badges, 4 seed tags (bug, feature, improvement, docs)
- Search/filter: real-time text search in header, priority dropdown filter, keyboard shortcut `/` to focus, Escape to clear
- Drag-and-drop: HTML5 DnD between columns (mouse-based, use `run-code` for `/` key on Windows/MSYS)
- Workspace panel: slide-in with read-only repo info, "New Workspace" button (repo resolved from project)
- Project switcher: dropdown in header when multiple projects registered
- API routes: health, projects (with git info), preferences (active-project + settings), board aggregation, issues (CRUD), workspaces (CRUD + actions), tags (CRUD), sessions (WebSocket + output history)
- Settings panel: gear icon in header, agent command/args, output parsing, mock agent toggle
- Session history: past sessions with replayable output in workspace panel
- Real-time board updates: board auto-refreshes via WebSocket when mutations happen
- Command palette: Ctrl+K searchable action list, keyboard navigation
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
- **Board events**: WS `/ws/board/:projectId` broadcasts `board_changed` events. Server-side board events service (`board-events.ts`) is passed to routes via factory options. Session manager's `onSessionExit` callback triggers board broadcast via projectId resolution.
- **Session messages**: All agent output is persisted to `session_messages` table (fire-and-forget insert in `broadcast()`). Retrieved via `GET /api/sessions/:id/output`.
- **Command palette**: Actions registered via `registerAction()` in `actions.ts`. BoardPage registers actions in `useEffect` with cleanup. Ctrl+K intercepted via `window` keydown listener (Playwright can't send Ctrl+K directly — Chromium intercepts it for address bar focus). E2E tests dispatch via `page.evaluate(() => window.dispatchEvent(...))`.
- **Route factory options**: Routes that need board events receive `{ boardEvents }` via options object. The `createRoutes` function in `routes/index.ts` passes options down to `createIssuesRoute` and `createWorkspaceActionsRoute`.

## Visual Verification
Every feature that has a UI component must be visually verified using the `playwright-cli` skill (user-scoped). After implementing or modifying a feature:
1. Ensure dev servers are running (`pnpm dev`)
2. Use `/playwright-cli` to open the page, take a snapshot, and confirm the UI renders correctly
3. Take a screenshot only when needed for debugging — clean up `.png` files and `.playwright-cli/` after
4. Clean up any test data created during verification (reset DB with `pnpm db:migrate && pnpm db:seed`)

## Documentation Map
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
Workspaces (git worktrees) no longer require manual repo path input. The server resolves the repo path from the chain: workspace → issue → project → repoPath/defaultBranch. This means:
- `POST /api/workspaces/:id/setup` — creates worktree using project's repoPath
- `GET /api/workspaces/:id/diff` — diffs against project's defaultBranch
- `POST /api/workspaces/:id/merge` — merges into project's defaultBranch

## MVP Core Loop
Register repo (`pnpm cli -- register <path>`) → Create issue → Start workspace (auto-resolves git branch from project) → Launch Claude Code → View diff → Merge

## Reference Codebase
The original vibe-kanban is at `F:/projects/vibe-kanban` for reference. Key files:
- `crates/mcp/src/task_server/` — MCP tool definitions
- `crates/db/migrations/` — database schema evolution
- `crates/api-types/src/` — shared type definitions
- `shared/types.ts` — generated TypeScript types
