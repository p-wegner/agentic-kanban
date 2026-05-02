# Project State

## Current Stage: Stage 7 — Settings + Output Parsing (DONE)

### Stage 7 Checklist
- [x] Settings screen: gear icon in header, slide-in panel
- [x] Agent command setting: configurable binary name (e.g. `claude`, `claude-glm`)
- [x] Agent args setting: additional CLI arguments (e.g. `--settings`, `--model`)
- [x] Output parser: parse Claude's `stream-json` format in TerminalView
  - `system/init` — show model, tools, MCP servers
  - `assistant` — show text content
  - `result` — show cost, duration, usage stats
- [x] Preferences API: generic GET/PUT for settings (agent_command, agent_args, output_parser, mock_agent)
- [x] Agent settings wired to launch flow (read from preferences)
- [x] Mock agent: standalone script emitting stream-json NDJSON (packages/server/src/scripts/mock-agent.ts)
- [x] Mock agent toggle moved from WorkspacePanel checkbox to Settings panel
- [x] Server-side MOCK_AGENT=1 env var for global mock agent override
- [x] E2E tests: settings API (5 tests), settings UI (6 tests), mock agent preference integration
- [x] 28 unit tests + 42 E2E tests passing

### Claude stream-json output reference
Claude Code with `--output-format stream-json --verbose -p <prompt>` emits NDJSON lines:
- `{"type":"system","subtype":"init",...}` — session init (cwd, session_id, tools, model, permissionMode, mcp_servers)
- `{"type":"assistant","message":{...},"session_id":...}` — assistant messages (content array with type:text, type:tool_use)
- `{"type":"result","subtype":"success","duration_ms":...,"result":"...","total_cost_usd":...,"usage":{...}}` — final result

### Stage 6 Checklist
- [x] Schema: added repoPath, repoName, defaultBranch, remoteUrl to projects table
- [x] Schema: created preferences table (key/value store for activeProjectId)
- [x] Migration: 0002_bent_may_parker.sql (preferences table + 4 project columns)
- [x] Removed orphan reposRelations and repos relation from workspaces
- [x] Git info service: detectRepoInfo (validates git repo, detects branch/remote)
- [x] Seed update: only seeds tags, no default project, prints CLI hint
- [x] CLI: register, unregister, list, cleanup commands via commander
- [x] Preferences API: GET/PUT /api/preferences/active-project
- [x] Projects API: POST requires repoPath, auto-detects git info
- [x] Workspace flow refactor: setup/diff/merge resolve repoPath from project chain
- [x] MCP start_workspace: repoPath now optional (auto-resolved from project)
- [x] Client: project switcher dropdown in header (multi-project support)
- [x] Client: workspace panel shows read-only repo info, no repo path input
- [x] Tests: 28 unit tests passing (including preferences API + git-info + duplicate worktree check tests)
- [x] E2E tests updated: global setup creates project via API, board test uses project from global setup
- [x] E2E test fixes: unique suffixed status names (board API), find Todo/In Progress by name (not index), scoped edit panel input selector, column-aware drag target
- [x] Server logging: structured console.log at agent/session/workspace pipeline points for debugging
- [x] Worktree reuse: createWorktree returns existing worktree path instead of 500 error on duplicate
- [x] Client error messages: apiFetch reads JSON error body instead of showing generic status text
- [x] Stop hook fix: clear client edits from state on first block to prevent infinite loop
- [x] Mock agent: moved to Settings panel toggle (was WorkspacePanel checkbox)
- [x] Custom agent fix: skip claude-specific flags (--output-format, -p) when AGENT_COMMAND is set

### Stage 5 Checklist
- [x] Keyboard shortcuts (/ to search, Escape to close/clear)
- [x] Side-by-side diff viewer (unified/split toggle with paired line display)
- [x] Search/filter (search bar in header, priority dropdown, real-time filtering)
- [x] Tags (CRUD API, assign/remove from issues, tag badges on cards + detail panel, default seed tags)
- [x] Error handling and loading states (skeleton board, toast notifications for CRUD actions)

### Stage 4 Checklist
- [x] MCP server binary (agentic-kanban-mcp via @modelcontextprotocol/sdk + stdio transport)
- [x] Core tools: get_context, list_issues, get_issue, create_issue, update_issue, list_workspaces, start_workspace, get_workspace_diff
- [x] Claude Code config integration (.claude/settings.json with project-scoped MCP server)
- [x] E2E test: MCP tools round-trip (create → list → update → get_issue → list_workspaces via stdio)
- [x] DB auto-resolution (import.meta.dirname relative path to server/kanban.db)

### Stage 3 Checklist
- [x] WebSocket infrastructure (@hono/node-ws, WS proxy in Vite)
- [x] Git service (worktree create/remove, diff, merge via execFile)
- [x] Agent service (subprocess launch/kill, AGENT_COMMAND test substitution)
- [x] Session manager (DB row lifecycle, WS subscriber broadcast)
- [x] Workspace action routes (setup, launch, stop, diff, merge, sessions)
- [x] Shared types (SetupWorkspaceRequest, LaunchAgentRequest, SessionResponse, DiffResponse, AgentOutputMessage)
- [x] Client: WorkspacePanel (slide-in, create/setup/launch/stop/diff/merge workflow)
- [x] Client: TerminalView (auto-scroll, connection status, color-coded output)
- [x] Client: DiffViewer (unified diff parsing, color-coded hunks, stats)
- [x] Client: useWebSocket hook (connection lifecycle, message accumulation)
- [x] IssueDetailPanel: workspaces section with count + Manage button
- [x] IssueCard: workspace indicator dot
- [x] Server tests: 37 passing (including git service unit tests with temp repos)
- [x] E2E tests: workspace lifecycle API test, workspace panel UI test

### Stage 0 Checklist
- [x] Clone and analyze original repo (vibe-kanban)
- [x] Document features and architecture (10 docs in `docs/prd/`)
- [x] Define MVP scope (`docs/prd/05-mvp-scope.md`)
- [x] **Choose tech stack** — TypeScript: Hono + Drizzle ORM + @libsql/client (server), React + Vite + Tailwind v4 (client), pnpm workspaces
- [x] **Set up project skeleton** with test infrastructure

### Stage 1 Checklist
- [x] Board aggregation endpoint (`GET /api/projects/:id/board`)
- [x] Workspace CRUD routes (POST, GET, PATCH, DELETE + issue workspaces list)
- [x] Vitest unit test setup with in-memory DB (17 tests passing)
- [x] Client updated to use board endpoint (single API call)
- [x] Playwright e2e tests for workspaces and board endpoints
- [x] Shared types for workspace request/response

### Stage 2 Checklist
- [x] Shared types dependency wired into client package
- [x] BoardColumn component extracted from BoardPage
- [x] IssueCard component with priority badges and description preview
- [x] CreateIssueForm inline per column (+ title, description, priority, add/cancel)
- [x] IssueDetailPanel slide-in with view/edit/delete modes
- [x] HTML5 Drag-and-drop between columns (no library, drag counter pattern)
- [x] Reorder within column via drop-gap divs + sortOrder midpoint arithmetic
- [x] Error banner, loading spinner, empty state, Escape key handling
- [x] E2E tests: create, edit, delete, drag, cancel, escape, error banner (24 tests total)

### Open Decisions
| ID | Question | Status | Doc |
|----|----------|--------|-----|
| D1 | Python (FastAPI) or TypeScript (Hono/Next)? | RESOLVED: TypeScript | `docs/decisions/001-initial-scope.md` |
| D2 | Claude Agent SDK directly or subprocess CLI? | RESOLVED: subprocess CLI (claude CLI via child_process.spawn) | `docs/prd/04-agent-integration.md` |
| D3 | Docker isolation or bare-metal git worktrees? | RESOLVED: bare-metal git worktrees | `docs/prd/04-agent-integration.md` |
| D4 | Schema vs docs alignment — fix code or docs? | RESOLVED: mixed — fix docs for tags/workspace/repo, add exit_code + is_default + tag filter + tag CRUD to code | `docs/decisions/002-align-docs-and-schema.md` |

### Stage Progress
| Stage | Description | Status |
|-------|-------------|--------|
| 0 | Foundation | DONE |
| 1 | Data Layer + API | DONE |
| 2 | Kanban UI | DONE |
| 3 | Workspace + Agent | DONE |
| 4 | MCP Integration | DONE |
| 5 | Polish | DONE |
| 6 | Git Repo Management | DONE |
| 7 | Settings + Output Parsing | DONE |

## Monorepo Structure
```
packages/
  shared/     - Drizzle schema (9 tables) + TypeScript types
  server/     - Hono API + @libsql/client + SQLite (port 3001) + CLI (commander)
  client/     - React + Vite + Tailwind v4 (port 5173)
  mcp-server/ - MCP stdio server (8 tools: get_context, list/get/create/update_issue, list/start_workspace, get_workspace_diff)
  e2e/        - Playwright tests (42 tests: API + UI, global setup creates project)
```

## API Routes
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/projects | List all projects |
| POST | /api/projects | Create a project |
| GET | /api/projects/:id/statuses | List statuses for a project |
| POST | /api/projects/:id/statuses | Create a status |
| GET | /api/projects/:id/board | Get board (statuses + nested issues) |
| GET | /api/issues?projectId= | List issues for a project |
| POST | /api/issues | Create an issue |
| PATCH | /api/issues/:id | Update an issue |
| DELETE | /api/issues/:id | Delete an issue |
| GET | /api/issues/:id/workspaces | List workspaces for an issue |
| POST | /api/workspaces | Create a workspace |
| GET | /api/workspaces/:id | Get workspace with issue info |
| PATCH | /api/workspaces/:id | Update workspace status |
| DELETE | /api/workspaces/:id | Delete a workspace |
| POST | /api/workspaces/:id/setup | Create git worktree for workspace |
| POST | /api/workspaces/:id/launch | Launch agent session |
| POST | /api/workspaces/:id/stop | Stop running agent session |
| GET | /api/workspaces/:id/diff | Get git diff for workspace |
| POST | /api/workspaces/:id/merge | Merge branch and close workspace |
| GET | /api/workspaces/:id/sessions | List sessions for workspace |
| GET | /ws/sessions/:sessionId | WebSocket: stream agent output |
| GET | /api/tags | List all tags |
| POST | /api/tags | Create a tag |
| PATCH | /api/tags/:id | Update a tag (name, color) |
| DELETE | /api/tags/:id | Delete a tag (removes issue associations) |
| GET | /api/issues/:id/tags | Get tags for an issue |
| POST | /api/issues/:id/tags | Assign tag to issue |
| DELETE | /api/issues/:id/tags/:tagId | Remove tag from issue |
| GET | /api/preferences/active-project | Get active project ID |
| PUT | /api/preferences/active-project | Set active project ID |
| GET | /api/preferences/settings | Get agent settings (agent_command, agent_args, output_parser, mock_agent) |
| PUT | /api/preferences/settings | Update agent settings |

## MCP Tools
| Tool | Description |
|------|-------------|
| get_context | Project info, issue counts by status, active workspaces |
| list_issues | List issues with status/priority/tag filters |
| get_issue | Issue detail with associated workspaces |
| create_issue | Create issue with title, description, priority |
| update_issue | Update issue title, description, status, priority |
| list_workspaces | List workspaces filtered by issue or status |
| start_workspace | Create git worktree + workspace for an issue |
| get_workspace_diff | Get git diff for a workspace |

## Session Log
| Date | Session | Summary |
|------|---------|---------|
| 2026-05-01 | Discovery | Cloned repo, ran 4 parallel analysis agents, produced 10 PRD docs, defined MVP scope and staging plan |
| 2026-05-01 | Stage 0 | Set up TypeScript monorepo: 6 packages, Drizzle schema (8 tables), Hono API server with CRUD routes, React+Vite+Tailwind client, MCP server stub, Playwright e2e scaffold. Migrated from better-sqlite3 to @libsql/client (no VS build tools needed). Verified: /health, /api/projects, /api/issues, Vite proxy, board UI loads. |
| 2026-05-01 | Stage 1 | Added board aggregation endpoint, workspace CRUD routes, Vitest unit test setup (17 tests, in-memory DB), updated client to use single board API call, added Playwright e2e tests for workspaces and board. Refactored routes to use factory functions for testability. |
| 2026-05-01 | Stage 2 | Full Kanban UI interactivity: extracted BoardColumn + IssueCard + CreateIssueForm + IssueDetailPanel components. HTML5 DnD with drag counter pattern and sortOrder midpoint arithmetic. Error banner, loading spinner, empty state, Escape key. E2E tests expanded from 2 to 24 (10 UI + 14 API), all passing. Used shared types from workspace package. |
| 2026-05-01 | Stage 3 | Workspace + Agent infrastructure: WebSocket via @hono/node-ws, git worktree management (create/remove/diff/merge), agent subprocess launch with AGENT_COMMAND test substitution, session manager with WS subscriber broadcast, workspace action routes (setup/launch/stop/diff/merge/sessions), WorkspacePanel with TerminalView + DiffViewer + useWebSocket hook. Server tests: 37 passing (3 new git service tests). Resolved circular import by lazy session manager injection. |
| 2026-05-01 | Stage 4 | MCP server implementation: 8 tools using @modelcontextprotocol/sdk over stdio transport, connected to same SQLite DB as web server. Tools: get_context, list_issues, get_issue, create_issue, update_issue, list_workspaces, start_workspace, get_workspace_diff. Project-level .claude/settings.json configures MCP server for Claude Code. E2E test via stdio JSON-RPC. |
| 2026-05-01 | Stage 6 | Git repo management: each project IS a registered git repo. CLI (commander) with register/unregister/list/cleanup commands. Projects table gained repoPath/repoName/defaultBranch/remoteUrl columns. New preferences table for activeProjectId. Workspace actions (setup/diff/merge) now auto-resolve repoPath from project chain — no manual input needed. Client has project switcher in header, workspace panel shows read-only repo info. Seed no longer creates default project. 27 unit tests + 30 E2E tests passing. E2E tests use global setup for project creation, unique suffixed status names for isolation, and name-based status lookups for robustness. |
| 2026-05-02 | Integration | Added structured logging across workspace/agent pipeline (agent.service, session.manager, workspace-actions). Added "Mock agent" checkbox to WorkspacePanel for integration testing without Claude Code — sends node one-liner as agentCommand. Fixed agent.service to skip claude-specific flags when AGENT_COMMAND is set. Verified full integration via playwright-cli: create issue → workspace → worktree → launch mock agent → see output in TerminalView via WebSocket. 28 unit tests + 30 E2E tests passing. |
| 2026-05-02 | Bug fixes | Fixed worktree setup 500 error: createWorktree now reuses existing worktrees instead of throwing on duplicate branches. Path normalization for git --porcelain output on Windows (forward to backslash). Client apiFetch now reads JSON error body for actionable error messages. Fixed stop hook infinite loop by clearing client edits from state file on first block. 28 unit tests passing. |
| 2026-05-02 | Agent launch fix | Fixed real Claude agent launch: added --verbose flag required by stream-json, use stdin:"ignore" to prevent Claude from hanging, restrict shell:true to custom commands only (claude.exe doesn't need cmd.exe). Session manager buffers broadcast messages for late-connecting WS clients. |
| 2026-05-02 | Stage 7 complete | Settings + output parsing + mock agent improvements. Created standalone mock-agent.ts script that emits stream-json NDJSON. Moved mock agent toggle from WorkspacePanel to Settings panel. Added server-side MOCK_AGENT=1 env var for global override. Preferences API now accepts mock_agent key. E2E tests: 5 settings API tests, 6 settings UI tests, mock_agent preference integration test. 28 unit tests + 42 E2E tests passing. |
