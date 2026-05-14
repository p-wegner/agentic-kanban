# Installation Guide

## Prerequisites

| Requirement | Version | Install |
|-------------|---------|---------|
| [Node.js](https://nodejs.org/) | 20+ | `winget install OpenJS.NodeJS.LTS` or download from nodejs.org |
| [pnpm](https://pnpm.io/) | 10.12.1 | `corepack enable` then `corepack prepare pnpm@10.12.1 --activate` |
| [Git](https://git-scm.com/) | 2.20+ | `winget install Git.Git` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | latest | `npm install -g @anthropic-ai/claude-code` |

> **Note:** Node.js 20+ is recommended. The project uses modern APIs (`import.meta.dirname`, `node:sqlite`) that require Node 20.18+.

### Verifying prerequisites

```bash
node --version      # v20.x or later
pnpm --version      # 10.12.1
git --version       # 2.x
claude --version    # any recent version
```

## Install

```bash
git clone https://github.com/p-wegner/agentic-kanban.git
cd agentic-kanban
pnpm install
```

## Setup

One command initializes the database, seeds default tags, and registers the repo as a project:

```bash
pnpm db:setup
```

This runs three steps:
1. `pnpm db:migrate` — creates the SQLite database and applies all migrations
2. `pnpm db:seed` — inserts 4 default tags (bug, feature, improvement, docs)
3. `pnpm cli -- register .` — registers the current repo as a project with 5 default statuses (Todo, In Progress, In Review, Done, Cancelled)

## Run

```bash
pnpm dev
```

This starts two dev servers concurrently:
- **API server** on `http://localhost:3001`
- **Web client** on `http://localhost:5173`

Open http://localhost:5173 — the board loads with 3 active columns for the registered project.

## Registering Your Own Projects

To use the board with your own repositories:

```bash
pnpm cli -- register /path/to/your/repo
```

Each project maps 1:1 to a git repo. The CLI auto-detects the repo name, default branch, and remote URL. You can register multiple repos and switch between them in the board header.

## Desktop App (Optional)

For a native window with system tray support, additional prerequisites are needed:

- **Rust** — `scoop install rustup` then run `rustup-init.exe`
- **MSVC C++ Build Tools** — install via Visual Studio Installer ("Desktop development with C++" workload)

See [docs/desktop-setup.md](docs/desktop-setup.md) for detailed setup instructions.

Then run:

```bash
pnpm dev:desktop
```

## MCP Server

The MCP server lets AI agents interact with the board programmatically:

```bash
pnpm --filter @agentic-kanban/mcp-server dev
```

See the [README](README.md#mcp-server) for the list of available tools.

## Testing

```bash
pnpm test           # Vitest unit tests
pnpm test:e2e       # Playwright E2E tests
```

## Troubleshooting

### `EBUSY: resource busy or locked`

The SQLite database is locked by a running process. Stop the dev server before running migrations or resets:

```bash
# Stop all Node processes
Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
```

### `SQLITE_ERROR: no such column`

A migration was not applied. Check `packages/shared/drizzle/meta/_journal.json` for missing entries and run:

```bash
pnpm db:migrate
```

### Port already in use

```bash
# Find and kill processes on port 3001 or 5173
$proc = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($proc) { Stop-Process -Id $proc -Force }
```

### Reset to clean state

```bash
# Stop the dev server first!
pnpm db:reset              # wipe DB, re-migrate, re-seed
pnpm cli -- register .     # re-register the repo
pnpm dev
```
