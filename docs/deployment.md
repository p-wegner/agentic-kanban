# Production Deployment Guide

This guide covers running agentic-kanban outside of development mode — from source, as a background service, or as a desktop app.

## Table of Contents

- [npx / Published Package (Recommended)](#npx--published-package-recommended)
- [Running from Source](#running-from-source)
- [Database Management](#database-management)
- [Environment Variables](#environment-variables)
- [MCP Server for Claude Code](#mcp-server-for-claude-code)
- [Tauri Desktop App](#tauri-desktop-app)
- [Running as a Background Service](#running-as-a-background-service)
- [Publishing a New Release](#publishing-a-new-release)
- [Troubleshooting](#troubleshooting)

---

## npx / Published Package (Recommended)

The easiest way to run agentic-kanban without cloning the repo is via the published npm package.

### Quick Start

```powershell
# Start the full app (server + UI) — opens browser automatically
npx agentic-kanban dev

# Register a git repo as a project
npx agentic-kanban register /path/to/your/repo

# Useful CLI commands
npx agentic-kanban list      # list registered projects
npx agentic-kanban status    # show board overview
npx agentic-kanban --help    # all available commands
```

The `dev` command starts the server in-process, serves the bundled React UI from the same port, and opens your browser. No separate client build or static file server needed.

### Custom Port

```powershell
npx agentic-kanban dev --port 8080
```

### MCP Server via npx

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

`DB_URL` must point to the same `kanban.db` file the web server is using. If omitted, the MCP server creates its own isolated database — changes from the UI won't be visible to Claude Code and vice versa.

### Build Output Structure

When published, the package has this layout inside `dist/`:

```
cli.js          ← CLI entry (npx agentic-kanban)
server.js       ← server entry (spawned by dev command)
mcp.js          ← MCP server entry (npx agentic-kanban-mcp)
client/         ← Vite-built React app
migrations/     ← Drizzle SQL migrations + journal
```

esbuild bundles server and MCP source into single files; `@agentic-kanban/shared` is inlined. npm runtime dependencies (hono, drizzle-orm, etc.) remain as regular `dependencies` in package.json and are installed by npm on `npx` invocation.

---

## Running from Source

### Prerequisites

- **Node.js** 20+ (the server uses `node:sqlite`)
- **pnpm** 10+
- **Git** (for worktree-based workspaces)
- **Claude Code** (the agent CLI) — optional, only needed if you want AI agent integration

### Production Build

The monorepo builds three packages:

```powershell
# Install dependencies
pnpm install

# Build all packages
pnpm build
```

This runs in order:
1. `shared` — compiles TypeScript schemas/utilities
2. `server` — compiles the Hono server (`tsc`)
3. `client` — Vite production build (static React app)

Build output locations:
- `packages/shared/dist/` — compiled shared library
- `packages/server/dist/` — compiled server
- `packages/client/dist/` — static React app (HTML + JS + CSS)

### Starting the Server

After building, start the server directly:

```powershell
cd packages/server
node dist/index.js
```

Or use the npm script:

```powershell
pnpm --filter @agentic-kanban/server start
```

The server listens on port 3001 by default (configurable via `PORT` env var).

**Note:** In production mode, the server does **not** serve the client static files. The client `dist/` is built separately. To serve both from one port, place a reverse proxy (e.g., nginx, Caddy) in front:
- `/` → serve `packages/client/dist/` as static files
- `/api/*` and `/ws/*` → proxy to the Node.js server

### First-Time Setup

```powershell
# Initialize the database
pnpm db:migrate
pnpm db:seed

# Register your git repository as a project
pnpm cli -- register /path/to/your/repo
```

---

## Database Management

### File Locations

The server uses SQLite via `node:sqlite` (libsql). Database files are created relative to the working directory:

| Location | Purpose |
|----------|---------|
| `packages/server/kanban.db` | Primary database (server) |
| `packages/mcp-server/kanban.db` | MCP server copy |
| `kanban.db` (repo root) | Legacy (no longer used) |

Each worktree has its own database — they are **not shared** between the main checkout and worktrees.

### Schema

Migrations live in `packages/shared/drizzle/*.sql` and are tracked in `packages/shared/drizzle/meta/_journal.json`. The server automatically runs pending migrations on startup.

To check applied migrations:
```powershell
cd packages/server
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('kanban.db');console.log(db.prepare('SELECT * FROM __drizzle_migrations ORDER BY created_at').all())"
```

### Backup Strategy

SQLite is a single-file database. For backup:

**Cold backup** (stop the server first):
```powershell
# Stop the server, then copy the DB file
Copy-Item packages/server/kanban.db packages/server/kanban.db.bak
```

**Hot backup** (while server is running):
```powershell
cd packages/server
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('kanban.db');db.exec('.backup kanban.db.bak')"
```

**Scheduled backup** (Windows Task Scheduler or cron):
```powershell
$timestamp = Get-Date -Format "yyyy-MM-dd-HHmmss"
Copy-Item packages/server/kanban.db "backups/kanban-$timestamp.db"
```

### Database Reset

This deletes all data and recreates the schema:
```powershell
# Stop the server first!
pnpm db:reset
pnpm cli -- register /path/to/your/repo
```

---

## Environment Variables

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP server port |
| `KANBAN_HOST` | `127.0.0.1` | Hostname/interface to bind. Set to `0.0.0.0` (or a specific Tailscale/LAN IP) to accept connections from other machines. |
| `KANBAN_TLS_CERT` | — | Path to a PEM **certificate**. When set together with `KANBAN_TLS_KEY`, the server serves over TLS with **HTTP/2** instead of plain HTTP/1.1 (see below). |
| `KANBAN_TLS_KEY` | — | Path to the PEM **private key** that pairs with `KANBAN_TLS_CERT`. |
| `MOCK_AGENT` | — | Set to `1` to use mock agent for all workspace launches |
| `AGENT_COMMAND` | — | Override the agent binary path (used by E2E tests) |

### HTTPS / HTTP/2 (network access)

By default the server runs plain **HTTP/1.1** — correct for the local-first, single-user case (`http://localhost:3001`). Browsers cap HTTP/1.1 at ~6 concurrent connections per origin, which can throttle request-heavy views when the board is accessed **over a network**.

Set `KANBAN_TLS_CERT` **and** `KANBAN_TLS_KEY` to PEM file paths to serve over TLS with **HTTP/2**, which multiplexes every request over a single connection (no 6-connection cap). The opt-in is a no-op when the variables are unset.

```powershell
$env:KANBAN_TLS_CERT = "C:\certs\board.crt"
$env:KANBAN_TLS_KEY  = "C:\certs\board.key"
$env:KANBAN_HOST     = "0.0.0.0"          # accept remote connections
npx agentic-kanban dev
# → Server running at https://0.0.0.0:3001 (HTTP/2, HTTP/1.1 fallback enabled)
```

Notes:
- **Browsers only negotiate HTTP/2 over TLS** — there is no benefit without a cert, and plain `http://localhost` dev stays HTTP/1.1.
- **HTTP/1.1 still works** (the server sets `allowHTTP1`), so non-HTTP/2 clients and the board's **WebSocket** live-updates (which upgrade over HTTP/1.1) keep functioning.
- If `KANBAN_TLS_CERT`/`KANBAN_TLS_KEY` are set but unreadable, the server logs a warning and falls back to HTTP/1.1.
- **Tailscale:** `tailscale cert <name>.ts.net` issues a browser-trusted cert + key you can point these variables at. Alternatively, front the plain HTTP/1.1 server with a TLS-terminating reverse proxy (`tailscale serve`, Caddy, nginx) — that also lifts the connection cap with zero app config.

### Development Script (`pnpm dev`)

The dev script (`scripts/dev.mjs`) sets additional variables when working in a git worktree:

| Variable | Description |
|----------|-------------|
| `SERVER_PORT` | Same as PORT |
| `VITE_PORT` | Client dev server port |
| `KANBAN_SERVER_PORT` | Port for agent subprocesses to reach the server |
| `KANBAN_CLIENT_PORT` | Port for agent subprocesses to reach the client |

### Agent Subprocess

The server passes these environment variables to spawned agent processes:
- `KANBAN_SERVER_PORT`
- `KANBAN_CLIENT_PORT`
- `SERVER_PORT`
- `PORT`

Agents use these to discover which ports the kanban server and client are running on.

### Settings (via Preferences API)

These are stored in the database and configurable via the Settings panel or API:

| Key | Default | Description |
|-----|---------|-------------|
| `agent_command` | (none, uses Claude Code) | Override agent binary command |
| `agent_args` | (none) | Additional arguments for the agent |
| `mock_agent` | `false` | Use mock agent instead of real Claude Code |
| `auto_merge` | `true` | Auto-merge workspaces after review |
| `auto_review` | `true` | Auto-launch AI review after agent completes |
| `review_auto_fix` | `true` | Allow review agent to fix issues directly |
| `claude_profile` | (none) | Claude Code profile name for agent sessions |
| `skip_permissions` | `false` | Pass `--dangerously-skip-permissions` to agents |
| `disabled_mcp_tools` | (empty) | Comma-separated MCP tool names to disable |

---

## MCP Server for Claude Code

The MCP server provides 35 tools for Claude Code to interact with the kanban board via stdio JSON-RPC.

### Configuration

Add to your Claude Code settings (`~/.claude/settings.json` or project `.claude/settings.json`).

**Via published package (recommended):**
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

**From a source checkout (compiled):**
```json
{
  "mcpServers": {
    "agentic-kanban": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"],
      "cwd": "/path/to/agentic-kanban"
    }
  }
}
```

**From a source checkout (tsx, no build step):**
```json
{
  "mcpServers": {
    "agentic-kanban": {
      "command": "npx",
      "args": ["tsx", "packages/mcp-server/src/index.ts"],
      "cwd": "/path/to/agentic-kanban"
    }
  }
}
```

### MCP Database

The MCP server has its own database at `packages/mcp-server/kanban.db`. If you want the MCP server and web server to share a database, set the `DB_URL` environment variable:

```json
{
  "mcpServers": {
    "agentic-kanban": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"],
      "cwd": "/path/to/agentic-kanban",
      "env": {
        "DB_URL": "packages/server/kanban.db"
      }
    }
  }
}
```

**Note:** Both the MCP server and web server can safely use the same SQLite file — SQLite handles concurrent reads and serializes writes via WAL mode.

### Tool Disabling

Tools can be disabled via the Settings panel in the web UI (Settings > MCP Tools tab) or by setting the `disabled_mcp_tools` preference to a comma-separated list of tool names.

---

## Tauri Desktop App

The desktop app wraps the web UI in a native window with system tray support and OS notifications.

For full setup instructions, see [desktop-setup.md](desktop-setup.md).

### Quick Build

```powershell
# Prerequisites: Rust + MSVC C++ Build Tools
pnpm build                     # build server + client first
pnpm --filter @agentic-kanban/desktop build
```

The installer is produced at `packages/desktop/src-tauri/target/release/bundle/`.

### Distribution

The Tauri build produces:
- **Windows**: `.msi` installer and `.exe` (NSIS)
- **macOS**: `.dmg` and `.app`
- **Linux**: `.deb` and `.AppImage`

The desktop app bundles:
- The Node.js server (runs as a background process)
- The static React client
- Tauri native shell

### Auto-Start Configuration

The desktop app does **not** auto-start on login by default. To enable this:
1. Create a shortcut to the installed executable
2. Place it in the Windows Startup folder (`shell:startup`)

---

## Running as a Background Service

### Windows (nssm)

Use [nssm](https://nssm.cc/) to run the server as a Windows service:

```powershell
# Install nssm
scoop install nssm

# Create the service
nssm install AgenticKanban "C:\Program Files\nodejs\node.exe" "C:\path\to\agentic-kanban\packages\server\dist\index.js"

# Configure working directory
nssm set AgenticKanban AppDirectory "C:\path\to\agentic-kanban\packages\server"

# Configure environment
nssm set AgenticKanban AppEnvironmentExtra PORT=3001

# Configure auto-restart
nssm set AgenticKanban AppRestartDelay 5000

# Start the service
nssm start AgenticKanban
```

### Linux (systemd)

Create `/etc/systemd/system/agentic-kanban.service`:

```ini
[Unit]
Description=Agentic Kanban Server
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/agentic-kanban/packages/server
ExecStart=/usr/bin/node dist/index.js
Environment=PORT=3001
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable agentic-kanban
sudo systemctl start agentic-kanban
```

### Docker

The repo ships a production `Dockerfile` (multi-stage, `node:22-bookworm-slim` — Debian/glibc is required by `@libsql/client` and the Claude Agent SDK native binary) and a `docker-compose.yml`. The image bundles git, pnpm, and the `claude` CLI; the server serves the built client UI on one port.

```bash
# .env next to docker-compose.yml (or export in the shell):
#   ANTHROPIC_API_KEY=sk-...        # or CLAUDE_CODE_OAUTH_TOKEN=...
docker compose up -d --build
# UI + API on http://<host>:3001
```

Key points:

- **State** lives in the `kanban-data` volume mounted at `/data`: the database (`AGENTIC_KANBAN_DIR=/data`), cloned repos (`KANBAN_REPOS_DIR=/data/repos`), and their `.worktrees`.
- **Agent auth**: the server strips `ANTHROPIC_*`/`CLAUDE_CODE_*` from agent spawn envs (cross-profile bleed guard), so the entrypoint (`docker/entrypoint.sh`) bridges `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` into a Claude profile (`~/.claude/settings_docker.json`) and selects it via the `claude_profile` preference. Alternatively mount an authenticated `~/.claude` to `/root/.claude` and set no env vars. The interactive `claude /login` flow does not work headless.
- **Getting repos in**: either register with a clone URL (Settings → Register project → "Clone from URL", or `agentic-kanban register --clone <url>`) — the server clones into `/data/repos` — or bind-mount host checkouts. When bind-mounting, mount the **parent** directory of the repos (worktrees are created as a `.worktrees` sibling of each repo) and register `/repos/<name>`. `safe.directory '*'` is preconfigured for foreign-UID mounts.
- **Commit identity** comes from `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env (defaults set in compose).
- **No app-level auth** — run on a trusted network (VPN/Tailscale) or behind an authenticating reverse proxy.

---

## Publishing a New Release

The project uses [changesets](https://github.com/changesets/changesets) for versioning. The published package is `agentic-kanban` on npm.

### Standard Release

```powershell
# 1. Record what changed
pnpm changeset          # select packages + version bump type (patch/minor/major)

# 2. Bump versions (consumes changesets, updates package.json)
pnpm version

# 3. Build and publish
pnpm release            # runs: pnpm build && changeset publish
```

### Verify Build Before Publishing

```powershell
pnpm build

# Check dist output
ls packages/server/dist/
# Expected: cli.js, server.js, mcp.js, client/, migrations/

# Smoke-test locally
node packages/server/dist/cli.js --help
node packages/server/dist/cli.js dev

# Dry-run publish
npm publish --dry-run --workspaces=false --prefix packages/server
```

### Beta / Prerelease

```powershell
pnpm changeset pre enter beta
pnpm changeset version
pnpm release
pnpm changeset pre exit
```

Users install the beta with:
```powershell
npx agentic-kanban@beta dev
```

---

## Troubleshooting

### Port Already in Use

```
[fatal] Port already in use — exiting: listen EADDRINUSE
```

Find and kill the process on the specific port:
```powershell
$proc = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($proc) { $proc | ForEach-Object { Stop-Process -Id $_ -Force } }
```

**Never kill all Node processes** — other workspaces may be running on different ports.

### Database Locked (EBUSY)

```
Error: SQLITE_BUSY: database is locked
```

Another process has the database open. Stop the server before running DB commands:
```powershell
# Stop the server
$proc = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($proc) { $proc | ForEach-Object { Stop-Process -Id $_ -Force } }

# Then run your DB command
pnpm db:migrate
```

### Missing Column Errors

```
SQLITE_ERROR: no such column: issue_number
```

A migration was not applied. Check:
1. The SQL file exists in `packages/shared/drizzle/`
2. The migration has an entry in `packages/shared/drizzle/meta/_journal.json`
3. Run `pnpm db:migrate` to apply pending migrations

See `.llm/workflows.md` for detailed migration debugging.

### Stale Sessions After Restart

If the server crashes or is killed ungracefully, sessions may be stuck in "running" state. The server automatically cleans these up on startup:
- Sets stale sessions to "stopped"
- Sets stuck workspaces to "idle"
- Prunes orphaned worktrees

No manual intervention needed — just restart the server.

### Agent Not Launching

Common causes:
1. **Claude Code not in PATH** — ensure `claude` is available from the server's working directory
2. **Wrong profile** — check `claude_profile` setting matches a valid Claude Code profile
3. **Permission denied** — on Linux/macOS, ensure the worktree directory is writable by the server process

Check agent command override in Settings:
```
Settings > Agent > Command
```

### MCP Tools Not Appearing in Claude Code

1. Verify the MCP server runs standalone:
   ```powershell
   cd packages/mcp-server
   npx tsx src/index.ts
   ```
2. Check Claude Code settings has the correct path to the MCP server
3. Restart Claude Code after config changes
4. Check `disabled_mcp_tools` setting — tools may be individually disabled

### Git Worktree Issues

**Detached HEAD:** Rebase or other operations can leave worktrees in detached HEAD state. The server's `syncBranchToHead()` and `ensureOnBranch()` functions handle this automatically before merge operations.

**Worktree cleanup:** Closed workspaces may leave orphaned worktrees. The server prunes these on startup, or use the CLI:
```powershell
pnpm cli -- cleanup
# Then manually remove:
git worktree remove --force <path>
```

### WebSocket Connection Failures

The board and session views use WebSocket connections (`/ws/board/:projectId`, `/ws/sessions/:sessionId`). If WebSockets don't connect:

1. **Reverse proxy** — ensure your proxy forwards WebSocket upgrade headers (`Upgrade: websocket`, `Connection: Upgrade`)
2. **Firewall** — check that the server port is open
3. **Client fallback** — the board has a 30-second polling fallback, so data still refreshes without WebSocket
