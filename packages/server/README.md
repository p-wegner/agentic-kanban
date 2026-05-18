# agentic-kanban

A kanban board for managing AI-driven coding tasks with Claude Code. Local-first, single-user, built on Hono + SQLite + React.

Each issue card on the board is backed by a git worktree and a live Claude Code session. The core loop: **plan → execute (Claude Code) → review diff → merge**.

## Quick Start

```bash
# Start the full app — opens browser automatically
npx agentic-kanban dev

# Register a git repo as a project
npx agentic-kanban register /path/to/your/repo

# Other commands
npx agentic-kanban list      # list registered projects
npx agentic-kanban status    # board overview (active agents, workspaces)
npx agentic-kanban --help    # all commands
```

## MCP Server (Claude Code Integration)

Add to your `.claude/settings.json` or `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "agentic-kanban": {
      "command": "npx",
      "args": ["-y", "agentic-kanban-mcp"],
      "env": {
        "DB_URL": "/absolute/path/to/kanban.db"
      }
    }
  }
}
```

`DB_URL` must point to the same `kanban.db` the web server uses (printed on startup). This gives Claude Code 27 tools to interact with the board: create issues, start workspaces, get diffs, merge branches, and more.

## Features

- Kanban board with drag-and-drop, priority badges, tags, collapsible archive columns
- One-step workspace creation: branch + git worktree + Claude Code auto-launched with issue as prompt
- Live agent output via WebSocket with chat-like follow-up input and `--resume` session continuity
- AI code review: auto-review on session exit, manual review button, auto-fix mode
- MCP server with 27 tools for agent integration
- Command palette (Ctrl+K), keyboard shortcuts, real-time board updates
- Agent skills: prompt templates injected into workspaces (board-navigator, code-review, dependency-analyzer, ticket-enhancer + custom)
- Workspace setup scripts: run `pnpm install` or other setup commands automatically after worktree creation
- Session history: browse past agent sessions per workspace
- Multi-project: register multiple git repos, switch via header dropdown
- Desktop app (Tauri v2): system tray, minimize-to-tray, OS notifications

## Development Setup

```bash
git clone https://github.com/p-wegner/agentic-kanban.git
cd agentic-kanban
pnpm install
pnpm db:setup    # migrate + seed + register this repo
pnpm dev         # server :3001 + client :5173
```

## License

MIT
