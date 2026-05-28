# Agentic Kanban

A kanban board for managing AI-driven coding tasks. Built as a focused, local-first alternative to [vibe-kanban](https://github.com/BloopAI/vibe-kanban) — designed for single-user workflows with Claude Code as the agent.

Each task card on the board is backed by a git worktree and a live Claude Code session. The core loop is: **plan → execute (Claude Code) → review (diff) → ship (merge)**.

## Features

- **Kanban board** — drag-and-drop between columns (Todo, In Progress, In Review, Done, Cancelled), collapsible archive group
- **Issue management** — create, edit, delete, search/filter with highlighted matches, priority badges, tags, auto-incrementing issue numbers
- **Workspace lifecycle** — one-step creation: branch + git worktree + auto-launch Claude Code. Supports direct workspaces (no worktree) for quick tasks
- **Live agent output** — real-time streaming via WebSocket, chat-like input with Send/Stop, `--resume` support for session continuity
- **Diff viewer** — unified and split views with inline comments, diff stats, merge and close actions
- **MCP server** — 35 tools for AI agent integration (board status, issues, workspaces, review/merge, dependencies, skills, etc.)
- **Real-time board updates** — WebSocket push + polling fallback for cross-tab and MCP-driven changes
- **Command palette** — Ctrl+K action search with keyboard navigation
- **Multi-project** — register multiple git repos and switch between them
- **Session history** — browse past agent sessions per workspace without leaving context
- **Worktree overview** — see all git worktrees across workspaces with diff stats and status badges
- **Butler assistant** — a warm, persistent Claude (Agent SDK) per project (press `i`): chat for board/codebase guidance, per-project model & profile pickers, slash-command autocomplete, a Stop button, and it can orchestrate board work for you

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Hono (Node.js), Drizzle ORM, SQLite |
| Frontend | React, TypeScript, Tailwind CSS, Vite |
| Agent | Claude Code — per-task CLI subprocess, plus a warm in-process Butler (Agent SDK) |
| Integration | MCP SDK (stdio JSON-RPC) |
| Testing | Vitest (unit), Playwright (E2E) |
| Monorepo | pnpm workspaces |

## Getting Started

```bash
pnpm install
pnpm db:setup        # migrate + seed + register this repo as a project
pnpm dev             # start server (port 3001) + client (port 5173)
```

Open http://localhost:5173 — the board loads with 3 active columns for the registered project.

For detailed installation instructions including prerequisites, see [INSTALL.md](INSTALL.md).

### Reset to Clean State

Stop the dev server first, then:

```bash
pnpm db:reset        # wipe DB, re-migrate, re-seed tags
pnpm cli -- register .   # re-register the repo
pnpm dev
```

## CLI

```bash
pnpm cli -- register <path>     # register a git repo as a project
pnpm cli -- list                # list registered projects
pnpm cli -- unregister <name>   # remove a project by name or ID
pnpm cli -- cleanup             # show stale worktrees for closed workspaces
```

## Core Workflow

1. **Register repo** — `pnpm cli -- register /path/to/repo`
2. **Create issue** — add a task to the board via the inline form
3. **Start workspace** — click "New Workspace" on an issue card (creates branch + worktree + launches Claude Code with the issue as prompt)
4. **Review changes** — view the diff in the workspace panel, add inline comments
5. **Merge** — merge the branch into the project's default branch and close the workspace

## MCP Server

The MCP server exposes 35 tools for AI agent integration via stdio JSON-RPC. A representative subset (tool names are snake_case):

| Tool | Description |
|------|-------------|
| `get_context` | Current project context and issue counts |
| `get_board_status` | Comprehensive overview: active agents, workspace state, diff/session stats |
| `list_issues` / `get_issue` | List/filter issues; full issue detail with workspaces + dependencies |
| `create_issue` / `update_issue` / `move_issue` | Create, edit, and move issues |
| `start_workspace` | Create a bare git worktree for an issue (does **not** move the issue or launch an agent — to actually start work, the board's one-step `POST /api/workspaces` is used) |
| `review_workspace` | Run the AI code review on a workspace branch |
| `get_workspace_diff` / `merge_workspace` | Inspect the diff; merge the branch and close |
| `add_dependency` / `remove_dependency` | Manage typed issue dependencies |
| `list_agent_skills` / `get_agent_skill` / `create_agent_skill` | Manage agent skills |
| `ask_butler` | Ask the project Butler a question synchronously |

Run the MCP server:

```bash
pnpm --filter @agentic-kanban/mcp-server dev
```

## Testing

```bash
pnpm test                # Vitest unit tests
pnpm test:e2e            # Playwright E2E tests
```

## Architecture

```
packages/
├── server/        # Hono API server, SQLite DB, session manager, CLI
├── client/        # React frontend (Vite + Tailwind)
├── shared/        # Drizzle schemas, migrations, shared types
├── mcp-server/    # MCP server (stdio JSON-RPC, 35 tools)
└── e2e/           # Playwright end-to-end tests
```

Key patterns:
- **Server-side aggregation** — workspace summaries computed in the board endpoint, not client-side joins
- **Board events** — dual-path: WebSocket push for instant updates + 30s polling fallback
- **One-step workspace creation** — single POST creates DB record, git worktree, and launches agent
- **Session resume chains** — Claude's internal session ID captured for `--resume` on relaunch

## License

MIT

---

**Building agentic workflows for your team?** Peter Wegner consults on AI-driven development practices — [get in touch](https://github.com/p-wegner).

## Support

If this tool saves you time, consider [sponsoring development](https://github.com/sponsors/p-wegner).

---

[README.de.md](README.de.md) — Deutsche Version
[README.fr.md](README.fr.md) — Version française
[README.it.md](README.it.md) — Versione italiana
[README.ru.md](README.ru.md) — Русская версия
