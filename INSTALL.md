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
1. `pnpm db:migrate` — creates the SQLite database (`packages/server/kanban.db`) and applies all migrations
2. `pnpm db:seed` — seeds the built-in tags, default agent skills, and workflow templates
3. `pnpm cli -- register .` — registers the current repo as a project, setting it active, with the 7 default statuses (Backlog, Todo, In Progress, In Review, AI Reviewed, Done, Cancelled)

> **Where the DB lives:** in this dev checkout the database is `packages/server/kanban.db` (drizzle's `drizzle.config.ts` uses the relative `file:kanban.db`). If that file does **not** exist, the server falls back to `~/.agentic-kanban/kanban.db` (see `packages/server/src/db/data-dir.ts`) — so if the board looks empty/wrong, confirm `packages/server/kanban.db` exists and that `pnpm db:migrate` actually created it there. Override with `AGENTIC_KANBAN_DIR` or `DB_URL`.

> **If `pnpm db:migrate` exits non-zero with no clear error** (a drizzle-kit spinner can swallow it), it usually still created the DB file. The server's own startup also runs migrations, so just continue to `pnpm dev` — the server completes the schema and seeds on boot. For genuine migration/lock trouble use `pnpm db:repair` (the `db-doctor` skill), never `db:reset`/delete.

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

## Clean-clone / first-start gotchas (Windows)

A fresh clone on Windows can hit several non-obvious blockers in a row. Each below is the *symptom → cause → fix*. If first start is rough, work through them in order.

### 1. `pnpm dev` dies immediately with `spawn pnpm ENOENT`

**Cause:** `scripts/dev.mjs`, `scripts/server-dev-proxy.mjs`, and the dev preflights all spawn `pnpm` with `spawn(..., { shell: false })`. Node's `spawn` (without a shell) needs a real **executable** on `PATH` — it will not run a PowerShell-only shim. If `pnpm` was installed via `npm i -g pnpm`, it resolves to `…\AppData\Roaming\npm\pnpm.ps1` (no `.exe`), and every `spawn("pnpm")` fails with `ENOENT`. This also breaks the *self-healing* preflights (their `pnpm install --force` can't run either), so the board can't even repair itself.

**Check:**
```powershell
(Get-Command pnpm).Source     # must be a .exe or .cmd, NOT only a .ps1
```

**Fix:** install pnpm as a spawnable binary:
```powershell
scoop install pnpm            # gives ~\scoop\shims\pnpm.exe (first on PATH)
# or: corepack enable; corepack prepare pnpm@10.12.1 --activate
```
(Note: scoop's bucket may lag the pinned version in `package.json` (`packageManager: pnpm@10.12.1`). It's fine for running the app; match the pinned version with corepack/a standalone 10.x exe when you can.)

### 2. Client (Vite) fails: `Failed to resolve entry for package "@agentic-kanban/shared"`

**Cause:** the client resolves `@agentic-kanban/shared` through the package's `import` export condition → `packages/shared/dist/…`. On a clean clone that `dist/` does **not** exist yet — it is gitignored, `pnpm install` has no `prepare` step that builds it, and `dev.mjs`'s shared preflight only restores *wiped source files from git*, it does not run the build. (The API **server** is unaffected: it runs tsx with `--conditions development`, which resolves shared to its `src/`.)

**Fix:** build the shared package once before the first client start:
```bash
pnpm --filter @agentic-kanban/shared build
```
After that the gitignored `dist/` persists locally. (Maintainer fix worth considering: add `"development"` to `resolve.conditions` in `packages/client/vite.config.ts` so the client also resolves shared to `src/` and needs no pre-build — that is the stated intent of the comment there, but `import` currently wins.)

### 3. `pnpm dev` server never comes up on `:3001` (proxy is up, API hangs)

**Symptom:** `[dev-proxy] API proxy listening at http://127.0.0.1:3001 -> 13001` and Vite are both up, but `http://127.0.0.1:3001/api/projects` hangs and nothing binds `13001`.

**Cause:** the proxy launches the backend as `pnpm exec tsx watch … src/index.ts`. On Windows, **`tsx watch` of the full server hangs** — the worker loads the whole module graph then never binds or logs (reproduced clean and isolated). Plain `tsx` of the same entry works, and `tsx watch` of a *trivial* file works, so it is a `watch`-layer interaction with the large server module graph (most likely file-watcher setup over the tree). Using a non-LTS Node (e.g. 23.x) appears to make it worse — prefer Node **LTS 20/22**.

**Workaround:** run the backend without watch (you lose hot-reload, but the app runs):
```powershell
# from packages/server, with the proxy/public port you want as KANBAN_INTERNAL_SERVER_PORT
$env:KANBAN_INTERNAL_SERVER_PORT="3001"; $env:SERVER_PORT="3001"
pnpm exec tsx --conditions development src/index.ts
# then run the client separately:  (from packages/client)  $env:SERVER_PORT="3001"; pnpm exec vite
```
Vite proxies `/api`, `/health`, `/ws` to `127.0.0.1:$SERVER_PORT`, so binding the backend directly on `3001` (no `13001` proxy) is enough for a working board.

### 4. `register .` on the agentic-kanban repo *itself* duplicates hooks

`pnpm db:setup` ends with `pnpm cli -- register .`. On a *new* project that scaffolds onboarding files; but run against **this** repo it appends generic hooks (`vital-file-guard.js`, `smart-hooks-runner.js`) to `.claude/settings.json` — which already has them — and **commits** the duplicate (`chore: scaffold agent guards and onboarding`). If you are a contributor setting up the dev checkout, drop that commit:
```bash
git reset --hard HEAD~1     # main checkout only; the DB registration is unaffected
```
