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
| Project + kanban columns | YES | Single project, 5 default columns |
| Create/edit/delete issues | YES | Title, description, priority, status |
| Drag-and-drop on board | YES | Basic DnD between columns |
| Workspace creation | YES | Git worktree + branch |
| Claude Code execution | YES | Via Agent SDK or subprocess |
| Diff viewer | YES | Basic unified diff |
| MCP server | YES | At least get_context + list_issues |
| SQLite persistence | YES | Local DB |
| Tags | NO | Simple text labels in description |
| Issue relationships | NO | Flat issue list only |
| Inline code comments | NO | View-only diff |
| PR creation | NO | Manual merge |
| Real-time WebSocket | YES | Agent output streaming |
| Multi-project | NO | Single project |
| Dark/light theme | NO | One theme |
| Command palette | NO | Standard UI |
| File attachments | NO | |
| Notifications | NO | |
| Multi-repo workspaces | NO | Single repo per workspace |
| Session history | NO | Current session only |
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
- [ ] MCP server binary
- [ ] Core tools: get_context, list_issues, get_issue, update_issue
- [ ] Claude Code config integration
- [ ] **E2E test: agent creates and updates issue via MCP**

### Stage 5: Polish
- [ ] Keyboard shortcuts
- [ ] Better diff viewer (side-by-side)
- [ ] Search/filter
- [ ] Tags
- [ ] Error handling and loading states

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
