# agentic-kanban

A kanban board for managing AI-driven coding tasks with Claude Code. Local-first, single-user, built on Hono + SQLite + React.

Each issue card on the board is backed by a git worktree and a live Claude Code session. The core loop: **plan -> execute (Claude Code) -> review diff -> merge**.

## Quick Start

```bash
# Start the board — auto-inits on first run, opens browser
npx agentic-kanban
```

That's it. On first run it creates the data directory, runs migrations, seeds defaults, and if you're in a git repo, registers it as a project. Open `http://localhost:3001` to use the board.

## Registering Projects

The board manages issues per git repository. Register repos to track them:

```bash
npx agentic-kanban register .                # register current directory
npx agentic-kanban register /path/to/repo    # register a specific repo
npx agentic-kanban register . --name "My App" # custom name
npx agentic-kanban list                      # show registered projects
npx agentic-kanban unregister "My App"       # remove a project
```

The first run auto-registers the current directory if it's a git repo. Register more repos later — switch between them from the board header dropdown.

## Data Directory

All data is stored locally in SQLite:

- **Default:** `~/.agentic-kanban/kanban.db`
- **Override:** set `AGENTIC_KANBAN_DIR` to use a different directory
- **Advanced:** set `DB_URL` to use any libsql-compatible URL

The database, migrations, and all state live in this single file. No cloud, no accounts.

## Agent Skills

Skills are prompt templates that teach AI agents how to use the board. Install them into your project so agents can manage issues, track progress, and follow the board workflow:

```bash
npx agentic-kanban install-skill .           # install all skills to .claude/skills/
npx agentic-kanban install-skill --list      # list available skills
npx agentic-kanban install-skill -n "kanban-workflow"  # install single skill
```

This works **without a running server** — it writes files directly from the bundled skill definitions.

### Built-in skills

| Skill | Description |
|-------|-------------|
| `kanban-workflow` | Complete guide for board management via MCP tools or CLI |
| `board-navigator` | MCP tool reference and board operations |
| `code-review` | AI code review prompt (customizable per project) |
| `code-review-thorough` | Deeper review using a more capable model |
| `dependency-analyzer` | Analyze ticket relationships and suggest dependency links |
| `ticket-enhancer` | Improve ticket clarity and completeness |
| `orchestrator` | Break work into sub-tasks and delegate to subagents |
| `monitor-nudge` | Nudge message for long-running agents |

## CLI Commands

```bash
# Board overview
npx agentic-kanban status                    # active issues with workspace state
npx agentic-kanban status --all              # include completed issues
npx agentic-kanban status --watch            # auto-refresh every 5s

# Issues
npx agentic-kanban issue create "Title"      # create issue (Todo by default)
npx agentic-kanban issue create "Title" -d "description" -p high
npx agentic-kanban issue list                # all issues
npx agentic-kanban issue list -s Todo        # filter by status
npx agentic-kanban issue get 17              # full details
npx agentic-kanban issue move 17 "In Progress"
npx agentic-kanban issue status 17           # workspace + session + last message
npx agentic-kanban issue summary 17          # session summary with files/stats

# Workspaces
npx agentic-kanban workspace list
npx agentic-kanban workspace resume 17       # relaunch agent on issue #17

# Dependencies
npx agentic-kanban issue dependency list <issue-id>
npx agentic-kanban issue dependency add <id> <target-id> -t depends_on

# Init (run manually or let auto-init handle it)
npx agentic-kanban init                      # set up data dir + migrate + seed
npx agentic-kanban init /path/to/repo        # init + register a project

# Skills
npx agentic-kanban skill list
npx agentic-kanban skill get <name>
npx agentic-kanban skill export .            # export from DB to .claude/skills/
npx agentic-kanban install-skill .           # install built-in skills (no DB needed)
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

`DB_URL` must point to the same `kanban.db` the web server uses (`~/.agentic-kanban/kanban.db` by default). This gives Claude Code 27 tools to interact with the board: create issues, start workspaces, get diffs, merge branches, and more.

## Features

- Kanban board with drag-and-drop, priority badges, tags, collapsible archive columns
- One-step workspace creation: branch + git worktree + Claude Code auto-launched with issue as prompt
- Live agent output via WebSocket with chat-like follow-up input and `--resume` session continuity
- AI code review: auto-review on session exit, manual review button, auto-fix mode
- MCP server with 27 tools for agent integration
- Command palette (Ctrl+K), keyboard shortcuts, real-time board updates
- Agent skills: prompt templates injected into workspaces
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
