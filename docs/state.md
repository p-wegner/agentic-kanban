# Project State

## Current Stage: Stage 5 — Polish

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

### Stage Progress
| Stage | Description | Status |
|-------|-------------|--------|
| 0 | Foundation | DONE |
| 1 | Data Layer + API | DONE |
| 2 | Kanban UI | DONE |
| 3 | Workspace + Agent | DONE |
| 4 | MCP Integration | DONE |
| 5 | Polish | READY |
| 6+ | Post-MVP | NOT STARTED |

## Monorepo Structure
```
packages/
  shared/     - Drizzle schema (8 tables) + TypeScript types
  server/     - Hono API + @libsql/client + SQLite (port 3001)
  client/     - React + Vite + Tailwind v4 (port 5173)
  mcp-server/ - MCP stdio server (8 tools: get_context, list/get/create/update_issue, list/start_workspace, get_workspace_diff)
  e2e/        - Playwright tests (API + UI)
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

## MCP Tools
| Tool | Description |
|------|-------------|
| get_context | Project info, issue counts by status, active workspaces |
| list_issues | List issues with status/priority filters |
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
