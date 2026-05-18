# Cline Kanban — Competitor Profile

**Repository**: [github.com/cline/kanban](https://github.com/cline/kanban)
**License**: Open source
**Last analyzed**: 2026-05-18

## What It Is

A kanban board for managing AI coding agent tasks, built by the Cline team. Each task gets an isolated git worktree and terminal session, enabling parallel autonomous execution. Distinguishes itself with multi-agent support, dependency chaining, and auto-commit/PR workflows.

## Architecture

| Aspect | Detail |
|--------|--------|
| Runtime | Node.js 22+ with TypeScript |
| Frontend | React + Tailwind CSS v4 + Radix UI + Lucide icons |
| API | tRPC for type-safe client-server communication |
| Server | Express.js with WebSocket support |
| Desktop | Electron with custom protocol handlers |
| Storage | JSON files (no database) |
| MCP | `@modelcontextprotocol/sdk` v1.27.1 with stdio/SSE/HTTP transports |
| Terminal | `node-pty` for real PTY-backed terminal sessions |

### Key Dependencies
- `@clinebot/core` / `@clinebot/shared` — Core Cline agent integration
- `@trpc/server` + `@trpc/client` — End-to-end type safety
- `node-pty` — Terminal emulation
- `xterm.js` — Terminal rendering in browser
- `zod` — Schema validation

## Core Features

### Board & Task Management
- **Columns**: Backlog, In Progress, Review, Done (formerly Trash)
- Task cards with prompts, auto-review settings, agent selection
- **Task dependencies**: Link tasks; auto-start linked cards when upstream completes
- **Auto-review modes**: Commit or PR — automatically ship work when agent finishes
- Drag-and-drop between columns

### Agent Execution
- **Multi-agent support**: Cline (native), Claude Code, OpenAI Codex, Factory Droid, Kiro, Gemini CLI, OpenCode
- Each task gets its own ephemeral worktree and terminal session
- Parallel execution without merge conflicts
- Agent-specific configurations per task
- Runtime hooks for task state transitions (`to_review`, `to_in_progress`, `activity`)

### Git Integration
- Ephemeral worktrees per task with automatic cleanup
- **Symlinked `node_modules`** — no `npm install` per task (uses symlinks from main checkout)
- Branch management and git history visualization
- Auto-commit and auto-PR from completed tasks
- Patch capture for trashed/discarded tasks
- Conflict resolution support

### Code Review
- Rich diff viewer with file tree navigation
- Multi-line diff comments with line selection
- Before/after comparisons
- Auto-review on task completion (configurable)

### MCP Server
- Full MCP SDK integration (stdio, SSE, HTTP transports)
- OAuth authentication for MCP servers with browser-based flow
- Automatic tool discovery and registration
- Per-server connection management with error handling
- Dynamic tool loading from configured servers

### Desktop App
- Electron wrapper (not Tauri)
- Window management with project persistence
- Protocol handlers for deep linking
- Menu integration

### Other Features
- **Script shortcuts**: Custom command shortcuts per project (e.g., `npm run dev`)
- Resizable panels (chat, git history, diff viewer)
- Dark theme with customizable color schemes
- Keyboard shortcuts (Cmd+click to link tasks)

## Data Model

- **Tasks**: ID, title, prompt, agent settings, auto-review config, images
- **Board**: Columns (backlog, in_progress, review, done), task cards
- **Dependencies**: fromTaskId → toTaskId links
- **Sessions**: Running task sessions with state and workspace info
- **Workspaces**: Project paths with git repositories
- **MCP Servers**: Configured servers with auth status

Storage is JSON-based — no SQLite or traditional database.

## Strengths

1. **Multi-agent orchestration** — broadest agent support of all competitors (7+ agents)
2. **Autonomous dependency chains** — task A completes → auto-starts task B
3. **Symlinked worktrees** — zero-install task isolation (fastest setup)
4. **Auto-commit/PR** — fully autonomous ship workflow
5. **MCP ecosystem** — OAuth, dynamic tool discovery, multiple transports
6. **Script shortcuts** — project-specific command shortcuts in UI

## Weaknesses

1. **JSON storage** — no query capability, scalability concerns, no migration system
2. **Electron** — heavier than Tauri, larger install size
3. **No E2E test suite visible** — no automated testing story apparent
4. **No mock agent** — no built-in testing harness for agent workflows
5. **No inline session history** — less granular session management than Agentic Kanban
6. **No command palette** — no quick-action search UI
