# PRD-05: MVP Scope and Staging Plan

## MVP Definition

### What is the MVP?
A local web application where you can:
1. Create issues on a kanban board
2. Start a Claude Code workspace for an issue
3. See the diff of changes
4. Merge the changes

**One sentence**: "A kanban board where clicking 'Start' on a task launches Claude Code in an isolated workspace and shows you the resulting diff."

### Feature Set (All Stages Complete)

| Feature | Status | Notes |
|---------|--------|-------|
| Project + kanban columns | DONE | Multi-project, 5 default columns, project switcher |
| Create/edit/delete issues | DONE | Title, description, priority, status, plan mode, skip review |
| Drag-and-drop on board | DONE | HTML5 DnD between columns |
| Workspace creation | DONE | Git worktree + branch, one-step create + auto-launch |
| Workspace deletion | DONE | Delete with confirmation, cascade removes sessions/messages |
| Ready for Merge badge | DONE | Mark workspace ready; green badge in workspace + all-workspaces panels |
| Copy issue reference | DONE | Clipboard button in detail panel copies #N Title string |
| IssueCard hover actions | DONE | Compact action row on hover: Resume, Start Workspace, Move to next status |
| Direct workspaces | DONE | Work on main checkout without worktree |
| Claude Code execution | DONE | Subprocess CLI with stream-json parsing |
| Diff viewer | DONE | Unified + split view with inline comments |
| MCP server | DONE | 27 tools: full CRUD + agent skills + board status |
| CLI | DONE | register, issue list/create/move, workspace list/create, skill list/get/create, status |
| SQLite persistence | DONE | Local DB, 13 tables, 20 migrations |
| Tags | DONE | CRUD API, colored badges, 4 seed tags |
| Issue relationships | DONE | 6 dependency types + analyze deps button |
| AI enhancement | DONE | "Enhance with AI" button on issue creation |
| Inline code comments | DONE | Create/edit/delete on diff lines |
| PR creation | SKIPPED | Manual merge only |
| Real-time WebSocket | DONE | Agent output streaming + board change events |
| Command palette | DONE | Ctrl+K with searchable actions |
| Session history | DONE | Inline session selector with replayable output |
| Chat-like agent UI | DONE | Persistent chat input with multi-turn --resume |
| AI code review | DONE | Auto-review on session exit, manual review, auto-fix |
| Live session stats | DONE | Real-time model name + token count on cards |
| Agent skills | DONE | 4 built-in skills + custom skills via DB |
| Agent task progress | DONE | TodoWrite progress on issue cards via WebSocket |
| Worktree overview | DONE | Branch icon, slide-in panel with diff stats |
| Desktop app | DONE | Tauri v2 with system tray + OS notifications |
| Dark/light theme | SKIPPED | Single theme |
| File attachments | SKIPPED | — |
| Multi-repo workspaces | SKIPPED | Single repo per workspace |
| Mobile support | SKIPPED | Desktop browser only |

## Staging Plan

### Stage 0: Foundation — DONE
- [x] Clone and analyze original repo
- [x] Document features and architecture
- [x] Define MVP scope
- [x] Choose tech stack — TypeScript (Hono + Drizzle + React + MCP SDK + Tauri v2)
- [x] Set up project skeleton with test infrastructure

### Stage 1: Data Layer + API — DONE
- [x] SQLite schema + migrations (Drizzle ORM)
- [x] CRUD API for projects, issues, statuses
- [x] Basic workspace model
- [x] E2E tests for API from day one (Vitest + Playwright)

### Stage 2: Kanban UI — DONE
- [x] Kanban board with columns
- [x] Issue cards with create/edit
- [x] Drag-and-drop between columns
- [x] Issue detail view (title, description, priority)
- [x] E2E tests for board interactions

### Stage 3: Workspace + Agent — DONE
- [x] Git worktree management
- [x] Claude Code subprocess launch
- [x] Terminal output streaming (WebSocket)
- [x] Basic diff viewer
- [x] E2E tests for workspace lifecycle

### Stage 4: MCP Integration — DONE
- [x] MCP server binary (@modelcontextprotocol/sdk, stdio transport)
- [x] Core tools: get_context, list_issues, get_issue, update_issue, etc.
- [x] Claude Code config integration
- [x] E2E test: agent creates and updates issue via MCP

### Stage 5: Polish — DONE
- [x] Keyboard shortcuts
- [x] Better diff viewer (side-by-side)
- [x] Search/filter
- [x] Tags
- [x] Error handling and loading states

### Stage 6: Git Repo Management — DONE
- [x] CLI: register/unregister/list/cleanup
- [x] Project = registered git repo
- [x] Preferences API (active project, settings)
- [x] Project switcher in header

### Stage 7: Settings + Output Parsing — DONE
- [x] Settings panel (gear icon, slide-in)
- [x] Agent command/args configuration
- [x] Output parser for Claude stream-json format
- [x] Mock agent for testing

### Stage 8: Session History + Real-time + Command Palette — DONE
- [x] Session message persistence (session_messages table)
- [x] Board events via WebSocket (/ws/board/:projectId)
- [x] Inline session history selector
- [x] Command palette (Ctrl+K)
- [x] Chat-like agent UI with --resume support

### Stage 9: Bug Fixes + Polish — DONE
- [x] Search "/" key fix, board refresh debounce, toast notifications
- [x] Favicon, column count badges, workspace tooltips

### Stage 10: Detail Panel Improvements — DONE
- [x] Status dropdown, keep panel open after save
- [x] Issue numbers, relative timestamps, unsaved changes warning

### Stage 11: Search & Navigation Enhancements — DONE
- [x] Search highlighting, keyboard shortcut help overlay
- [x] Panel animations, context-aware workspace button

### Stage 12: Inline Diff Comments — DONE
- [x] diff_comments table, CRUD API, unified/split view comments

### Stage 13: Output Parser V2 + Responsive Layout — DONE
- [x] Multi-block message parsing, thinking blocks, tool result errors
- [x] Responsive layout, smart hooks system

### Stage 14: Feature Extensions — DONE
- [x] AI enhancement for ticket creation
- [x] Subagent visibility in terminal
- [x] Agent task progress on issue cards
- [x] Extended dependency types (6 types)
- [x] Agent skills system (4 built-in + custom)

### Post-Stage 14 Extensions — DONE
- [x] Worktree overview panel with diff stats
- [x] Workspace deletion with cascade
- [x] Server resilience (error handlers, stale session cleanup)
- [x] Plan mode + skip review
- [x] AI code review workflow (auto/manual review, auto-fix)
- [x] Live session stats on cards
- [x] Settings redesign (tabbed modal)
- [x] Expandable issue creation panel
- [x] Desktop app (Tauri v2, system tray, OS notifications)
- [x] Workspace setup scripts
- [x] Active subagent count on cards
- [x] TaskCreate/TaskUpdate detection

## Testability Requirements

### E2E Test Infrastructure
Every stage ships with E2E tests. The test framework supports:
1. **Headless browser testing** (Playwright)
2. **API-level testing** (Playwright `page.request` against real server)
3. **MCP protocol testing** (stdio JSON-RPC client against MCP server)
4. **Git operations testing** (real git worktrees in temp dirs)

### Test Counts (Current)
- **76 unit tests** (Vitest) — tags, preferences, issue numbers, API routes, git service
- **~120 E2E tests** (Playwright) — API endpoints, UI interactions, MCP tools, board events, ready-for-merge, copy-issue-reference, all-workspaces, scheduled-runs

### Test Categories
| Category | Tool | Scope |
|----------|------|-------|
| Unit tests | Vitest | Individual functions, in-memory DB |
| API tests | Playwright (request context) | REST endpoints against real server |
| E2E tests | Playwright (browser) | Full user workflows |
| MCP tests | Custom stdio client | Agent tool calls via JSON-RPC |

### AI-Friendly Feedback Loops
The E2E test suite is runnable by an AI agent (Claude Code itself):
- Clear pass/fail output
- Screenshot on failure
- Fast iteration (< 30s for focused test run)

## Tech Stack

TypeScript monorepo with pnpm workspaces:
- **Server**: Hono + @libsql/client (SQLite) + Drizzle ORM
- **Client**: React + Vite + Tailwind v4
- **MCP Server**: @modelcontextprotocol/sdk + stdio transport
- **Desktop**: Tauri v2 (Rust native wrapper)
- **Tests**: Vitest (unit) + Playwright (E2E)
- **CLI**: Commander.js

This was chosen over Python (FastAPI) and Rust (Axum) for:
- Full-stack TypeScript consistency
- Excellent MCP SDK support
- React ecosystem for UI
- Fast E2E testing with Playwright
