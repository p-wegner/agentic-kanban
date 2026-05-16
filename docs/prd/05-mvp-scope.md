# PRD-05: MVP Scope and Staging Plan

## MVP Definition

### What is the MVP?
A local web application where you can:
1. Create issues on a kanban board
2. Start a Claude Code workspace for an issue
3. See the diff of changes
4. Merge the changes

**One sentence**: "A kanban board where clicking 'Start' on a task launches Claude Code in an isolated workspace and shows you the resulting diff."

### MVP Feature Set

| Feature | In MVP? | Notes |
|---------|---------|-------|
| Project + kanban columns | YES | Multi-project, 5 default columns, project switcher |
| Create/edit/delete issues | YES | Title, description, priority, status, plan mode, skip review |
| Drag-and-drop on board | YES | HTML5 DnD between columns |
| Workspace creation | YES | Git worktree + branch, one-step create + auto-launch |
| Workspace deletion | YES | Delete with confirmation, cascade removes sessions/messages |
| Direct workspaces | YES | Work on main checkout without worktree |
| Claude Code execution | YES | Subprocess CLI with stream-json parsing |
| Diff viewer | YES | Unified + split view with inline comments |
| MCP server | YES | 26 tools: full CRUD + agent skills + board status |
| CLI | YES | register, issue list/create/move, workspace list/create, skill list/get/create, status |
| SQLite persistence | YES | Local DB |
| Tags | YES | CRUD API, colored badges, 4 seed tags |
| Issue relationships | YES | 6 dependency types + analyze deps button |
| AI enhancement | YES | "Enhance with AI" button on issue creation |
| Inline code comments | YES | Create/edit/delete on diff lines |
| PR creation | NO | Manual merge |
| Real-time WebSocket | YES | Agent output streaming + board change events |
| Command palette | YES | Ctrl+K with searchable actions |
| Session history | YES | Inline session selector with replayable output |
| Chat-like agent UI | YES | Persistent chat input with multi-turn --resume |
| AI code review | YES | Auto-review on session exit, manual review, auto-fix |
| Live session stats | YES | Real-time model name + token count on cards |
| Agent skills | YES | 3 built-in skills + custom skills via DB |
| Agent task progress | YES | TodoWrite progress on issue cards via WebSocket |
| Worktree overview | YES | Branch icon, slide-in panel with diff stats |
| Desktop app | YES | Tauri v2 with system tray + OS notifications |
| Dark/light theme | NO | One theme |
| File attachments | NO | |
| Multi-repo workspaces | NO | Single repo per workspace |
| Mobile support | NO | Desktop browser only |

## Staging Plan

### Stage 0: Foundation (Current)
- [x] Clone and analyze original repo
- [x] Document features and architecture
- [x] Define MVP scope
- [ ] Choose tech stack
- [ ] Set up project skeleton with test infrastructure

### Stage 1: Data Layer + API
- [x] SQLite schema + migrations
- [x] CRUD API for projects, issues, statuses
- [x] Basic workspace model
- [x] **E2E tests for API from day one**

### Stage 2: Kanban UI
- [x] Kanban board with columns
- [x] Issue cards with create/edit
- [x] Drag-and-drop between columns
- [x] Issue detail view (title, description, priority)
- [x] **E2E tests for board interactions**

### Stage 3: Workspace + Agent
- [x] Git worktree management
- [x] Claude Code subprocess launch
- [x] Terminal output streaming (WebSocket)
- [x] Basic diff viewer
- [x] **E2E tests for workspace lifecycle**

### Stage 4: MCP Integration
- [x] MCP server binary
- [x] Core tools: get_context, list_issues, get_issue, update_issue
- [x] Claude Code config integration
- [x] **E2E test: agent creates and updates issue via MCP**

### Stage 5: Polish
- [x] Keyboard shortcuts
- [x] Better diff viewer (side-by-side)
- [x] Search/filter
- [x] Tags
- [x] Error handling and loading states

### Stage 6+: Post-MVP
- [ ] Multi-project support
- [ ] PR creation (GitHub API)
- [ ] Inline code review comments
- [ ] Session history and forking
- [ ] Real-time WebSocket updates
- [ ] Dark/light theme
- [ ] Multi-repo workspaces
- [ ] Agent configuration UI
- [ ] Command palette

## Testability Requirements

### E2E Test Infrastructure (Day 1)
Every stage must ship with E2E tests. The test framework must support:
1. **Headless browser testing** (Playwright recommended)
2. **API-level testing** (HTTP client against real server)
3. **MCP protocol testing** (stdio client against MCP server)
4. **Git operations testing** (real git worktrees in temp dirs)

### AI-Friendly Feedback Loops
The E2E test suite must be runnable by an AI agent (Claude Code itself):
- Clear pass/fail output
- Screenshot on failure
- Structured test results (not just console output)
- Fast iteration (< 30s for focused test run)

### Test Categories
| Category | Tool | Scope |
|----------|------|-------|
| Unit tests | pytest / vitest | Individual functions |
| API tests | httpx / supertest | REST endpoints |
| E2E tests | Playwright | Full user workflows |
| MCP tests | Custom stdio client | Agent tool calls |
| Integration tests | Docker + git | Workspace lifecycle |

## Tech Stack Decision Matrix

| Criterion | Python (FastAPI) | TypeScript (Next.js) | Rust (Axum) |
|-----------|------------------|---------------------|-------------|
| Development speed | High | High | Low |
| Testability | Excellent | Good | Good |
| MCP SDK support | Good | Good | Good (rmcp) |
| Agent SDK support | Good | Good | Limited |
| Git integration | Good (GitPython) | Good (simple-git) | Native |
| Frontend framework | Any (separate) | Integrated (React) | Separate (React) |
| Learning curve | Low | Medium | High |
| Ecosystem maturity | High | High | Medium |
| **Recommendation** | **Best for speed** | **Good balance** | **Overkill** |

**Recommendation**: Python (FastAPI + React) or TypeScript full-stack (Hono/Next + React). The key differentiator is E2E test quality.
