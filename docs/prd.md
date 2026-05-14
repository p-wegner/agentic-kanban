# Agentic Kanban — Product Requirements Document

## 1. Vision

A local-first kanban board where each task card is an AI agent session. You plan work as issues, execute via Claude Code in isolated git worktrees, review diffs, and merge — all from a single interface. No cloud, no multi-tenant, no team features. One user, one machine, full control.

Cleanroom reimplementation of [vibe-kanban](https://github.com/BloopAI/vibe-kanban) (34 Rust crates, being sunset) as a focused TypeScript alternative.

**One sentence**: *A kanban board where clicking "New Workspace" on an issue launches Claude Code in an isolated git worktree and shows you the resulting diff.*

## 2. Target User

A solo developer using Claude Code as their primary coding agent. They want to:
- Plan multiple tasks visually on a board
- Have Claude Code work on tasks in parallel in isolated branches
- Review code changes without leaving the board
- Merge completed work back to main

## 3. Tech Stack

| Layer | Technology |
|-------|-----------|
| Monorepo | pnpm workspaces (5 packages) |
| Server | Hono + @libsql/client + SQLite |
| ORM | Drizzle Kit (migrations + schema) |
| Client | React + Vite + Tailwind v4 |
| MCP Server | @modelcontextprotocol/sdk over stdio |
| E2E Tests | Playwright |
| Unit Tests | Vitest |
| Desktop | Tauri v2 (optional) |
| Agent | Claude Code CLI via child_process.spawn |
| Language | TypeScript throughout |

## 4. Core Workflow

```
1. Register repo:    pnpm cli -- register <path>
2. Create issue:     Title, description, priority on the board
3. Start workspace:  One click — creates git worktree + branch + launches Claude Code
4. Agent works:      Claude Code runs with issue title/description as prompt
5. Review diff:      Unified or split diff viewer with inline comments
6. Merge:            Merge branch into project's default branch, close workspace
```

## 5. Implemented Features

### 5.1 Board & Issues

- **Kanban columns**: 5 default statuses per project (Todo, In Progress, In Review, Done, Cancelled)
- **Collapsible groups**: Active columns shown inline; Done/Cancelled collapsed with counts, expandable
- **Issue CRUD**: Create (inline form per column), view, edit, delete
- **Issue fields**: Title, description (markdown), priority (urgent/high/medium/low), auto-incrementing issue number (#1, #2, ...)
- **Drag-and-drop**: HTML5 DnD between columns, reordering within columns via sortOrder
- **Search**: Real-time text search with highlighted matches, priority dropdown filter
- **Keyboard shortcuts**: `/` to search, `Escape` to close panels, `?` for help overlay, `Ctrl+K` command palette
- **Tags**: CRUD, colored badges, assign/remove from issues, 4 default seed tags (bug, feature, improvement, docs)
- **Workspace badges**: Cards show workspace count and status

### 5.2 Projects

- **Multi-project**: Register multiple git repos, switch between them via header dropdown
- **Git integration**: Auto-detects repo name, default branch, remote URL on registration
- **CLI**: `register`, `list`, `unregister`, `cleanup` commands via commander

### 5.3 Workspaces

- **One-step creation**: `POST /api/workspaces` creates DB record + git worktree + auto-launches agent
- **Branch management**: Auto-suggested branch names (`feature/<issue#>-<title>`), base branch selection from dropdown
- **Direct workspaces**: Work directly on main checkout (no worktree), purple badge, close instead of merge
- **Diff viewer**: Unified and split views, file-level navigation, diff stats, inline comments (CRUD)
- **Merge**: Merge workspace branch into project's default branch, close workspace
- **Deletion**: Delete workspace with confirmation, cascades to sessions, messages, and diff comments
- **Worktree overview**: Header button shows all git worktrees with issue linking, diff stats, status badges

### 5.4 Agent Sessions

- **Claude Code integration**: Launches `claude` CLI with `--output-format stream-json --verbose -p <prompt>`
- **Session resume**: Captures Claude's session_id from `system/init` events, passes `--resume <id>` for continued conversations
- **Real-time output**: WebSocket streaming of agent output, parsed for thinking blocks, text, tool use/results, and model usage
- **Chat interface**: Persistent chat input with Send/Stop toggle, `Ctrl+Enter` to send
- **Session history**: Inline session selector to browse past sessions without leaving workspace context
- **Mock agent**: Toggle in Settings for integration testing without Claude Code; server-side `MOCK_AGENT=1` env var
- **Configurable**: Agent command, args, and output parser configurable via Settings panel

### 5.5 Real-time Updates

- **WebSocket board events**: `WS /ws/board/:projectId` broadcasts `board_changed` on mutations
- **30s polling fallback**: Catches MCP, CLI, second tab, or WS failure updates
- **MCP notification**: MCP tools call `notifyBoard()` for instant updates
- **Smart panel sync**: Open detail panel auto-refreshes data on board changes; create form protected from mid-edit refreshes

### 5.6 MCP Server

8 tools via stdio JSON-RPC:

| Tool | Purpose |
|------|---------|
| `get_context` | Project info, issue counts, active workspaces |
| `list_issues` | List issues with status/priority/tag filters |
| `get_issue` | Issue detail with associated workspaces |
| `create_issue` | Create issue with title, description, priority |
| `update_issue` | Update issue title, description, status, priority |
| `list_workspaces` | List workspaces filtered by issue or status |
| `start_workspace` | Create worktree + workspace for an issue |
| `get_workspace_diff` | Get git diff for a workspace |

### 5.7 Desktop App (Tauri v2)

- Native window wrapper around the web UI
- System tray with Show/Quit
- Minimize-to-tray on close
- OS notifications on `session_completed` and `workspace_merged` events

## 6. Data Model

### 6.1 Core Entities

```
Project 1──* ProjectStatus
Project 1──* Issue
Issue    1──* Workspace
Issue    *──* Tag
Workspace 1──* Session
Workspace 1──* DiffComment
Session  1──* SessionMessage
```

### 6.2 Schema (11 tables, 8 migrations)

| Table | Purpose |
|-------|---------|
| `projects` | Registered git repos with name, repoPath, defaultBranch, remoteUrl |
| `project_statuses` | Kanban columns per project (name, sortOrder) |
| `issues` | Task cards (title, description, priority, issue_number, sortOrder) |
| `workspaces` | Isolated work environments (branch, workingDir, baseBranch, status) |
| `sessions` | Agent execution runs (exitCode, claudeSessionId, resumeFromId) |
| `session_messages` | Persisted agent output (type, data, exitCode) |
| `tags` | Colored labels (name, color) |
| `issue_tags` | Many-to-many issue ↔ tag |
| `diff_comments` | Inline code review comments (filePath, lineNum, side, body) |
| `preferences` | Key/value settings store (activeProjectId, agent config, mock_agent) |

### 6.3 Workspace Statuses

`active` | `running` | `idle` | `merged` | `closed` | `error`

### 6.4 Issue Priorities

`urgent` | `high` | `medium` | `low`

## 7. API Surface

### 7.1 REST Routes (32 endpoints)

Health: `GET /health`

Projects: `GET /api/projects` | `POST /api/projects` | `GET /api/projects/:id/statuses` | `POST /api/projects/:id/statuses` | `GET /api/projects/:id/board` | `GET /api/projects/:id/worktrees` | `DELETE /api/projects/:id/worktrees` | `GET /api/projects/:id/branches`

Issues: `GET /api/issues` | `POST /api/issues` | `PATCH /api/issues/:id` | `DELETE /api/issues/:id` | `GET /api/issues/:id/workspaces` | `GET /api/issues/:id/tags` | `POST /api/issues/:id/tags` | `DELETE /api/issues/:id/tags/:tagId`

Workspaces: `POST /api/workspaces` | `GET /api/workspaces/:id` | `PATCH /api/workspaces/:id` | `DELETE /api/workspaces/:id` | `POST /api/workspaces/:id/setup` | `POST /api/workspaces/:id/launch` | `POST /api/workspaces/:id/stop` | `GET /api/workspaces/:id/diff` | `POST /api/workspaces/:id/merge` | `GET /api/workspaces/:id/sessions` | `GET /api/workspaces/:id/comments` | `POST /api/workspaces/:id/comments` | `PATCH /api/workspaces/:id/comments/:commentId` | `DELETE /api/workspaces/:id/comments/:commentId`

Sessions: `GET /api/sessions/:sessionId/output`

Tags: `GET /api/tags` | `POST /api/tags` | `PATCH /api/tags/:id` | `DELETE /api/tags/:id`

Preferences: `GET /api/preferences/active-project` | `PUT /api/preferences/active-project` | `GET /api/preferences/settings` | `PUT /api/preferences/settings`

Internal: `POST /api/internal/board-notify`

### 7.2 WebSocket Routes

- `WS /ws/sessions/:sessionId` — stream agent output in real-time
- `WS /ws/board/:projectId` — broadcast board change events

## 8. Architecture

```
packages/
  shared/       Drizzle schema (tables, relations, types) + SQL migrations
  server/       Hono API server (port 3001) + CLI (commander) + agent/session/git services
  client/       React + Vite + Tailwind v4 (port 5173) — board, panels, diff viewer
  mcp-server/   MCP stdio server (8 tools) — connects to same SQLite DB
  e2e/          Playwright test suite
```

### Key Patterns

- **Route factory pattern**: Routes receive services (boardEvents, getSessionManager) via factory functions, not direct imports — avoids circular dependencies
- **Server-side aggregation**: Board endpoint computes workspace summaries via grouped query, no client-side joins
- **Dual-path board updates**: WebSocket for same-server, 30s polling for cross-process (MCP/CLI)
- **Fire-and-forget persistence**: Session messages inserted asynchronously in broadcast(), non-blocking

## 9. Testing

### Test Pyramid

- **76 unit tests** (Vitest): Tags CRUD, preferences, issue numbers, output parsing
- **100 E2E tests** (Playwright): API endpoints, UI interactions, workspace lifecycle, MCP tools

### Test Strategy

- E2E tests run against a real server with a real database
- Global setup creates a project before all tests
- `AGENT_COMMAND` env var substitutes agent binary for testing
- `MOCK_AGENT` preference enables mock agent for integration tests
- Git tests use real worktrees in temp directories
- Test data uses `Date.now()` suffixes to avoid accumulation conflicts

### AI-Friendly Design

The test suite is designed to be run by Claude Code itself as a feedback loop:
- Clear pass/fail output
- Screenshots on failure
- Focused test runs < 30s
- Deterministic results (retry loops for inherently async operations)

## 10. Non-Goals (Explicitly Skipped)

These features from the original vibe-kanban are intentionally excluded:

- Multi-tenant / organizations / team collaboration
- Cloud deployment / PostgreSQL / ElectricSQL
- Multiple AI agents (Claude Code only)
- OAuth / billing / Sentry / PostHog
- Mobile support / internationalization
- Preview browser / embedded SSH
- PR creation (manual merge only)
- File attachments / issue relationships (sub-issues, blocking)
- Dark/light theme
- Multi-repo workspaces

## 11. Setup & Operations

### First Run

```
pnpm install
pnpm db:setup          # migrate + seed + register .
pnpm dev               # server :3001 + client :5173
```

### Reset to Clean State

```
# Stop server first
pnpm db:reset          # deletes DB, re-migrates, re-seeds
pnpm cli -- register .
pnpm dev
```

### Development Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Server + client concurrently |
| `pnpm dev:desktop` | + Tauri native window |
| `pnpm --filter @agentic-kanban/server test` | Vitest unit tests |
| `pnpm test:e2e` | Playwright E2E tests |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:seed` | Seed default tags |
| `pnpm db:reset` | Wipe and recreate DB |
| `pnpm cli -- register <path>` | Register a git repo as project |
| `pnpm cli -- list` | List registered projects |
| `pnpm cli -- cleanup` | Show stale worktrees |

## 12. Future Considerations

Potential areas for future development (not committed):

- GitHub PR creation via API
- Multi-repo workspaces
- Issue relationships (sub-issues, blocking)
- Session forking
- Dark/light theme
- Agent configuration presets
- Export board data
- File attachments to issues
