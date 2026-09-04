# Installation Guide

## Prerequisites

| Requirement | Version | Install |
|-------------|---------|---------|
| [Node.js](https://nodejs.org/) | 22+ (LTS 22 recommended) | `winget install OpenJS.NodeJS.LTS` |
| [pnpm](https://pnpm.io/) | 10.12.1 | `corepack enable && corepack prepare pnpm@10.12.1 --activate` |
| [Git](https://git-scm.com/) | 2.20+ | `winget install Git.Git` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | latest | `npm install -g @anthropic-ai/claude-code` |

> Node.js **LTS 22** is the supported floor (`engines.node` = `>=22`, and both Dockerfile stages run `node:22-bookworm-slim`). Node 20 reached end of support on 2026-04-30 and is no longer supported here. Avoid odd-numbered releases: Node 23.x has a known issue where `tsx watch` of the full server hangs on Windows (see gotcha #3 below).

### Verify

```bash
node --version      # v20.x or later
pnpm --version      # 10.12.1
git --version
claude --version
```

## Install & first run

```bash
git clone https://github.com/p-wegner/agentic-kanban.git
cd agentic-kanban
pnpm install        # also builds packages/shared/dist (prepare script)
pnpm db:setup       # migrate + seed tags/skills + register this repo
pnpm dev            # server :3001, client :5173
```

Open http://localhost:5173.

> **DB location:** `packages/server/kanban.db`. If absent, the server silently falls back to `~/.agentic-kanban/kanban.db` — board looks empty/wrong. Confirm the file exists after `pnpm db:setup`.

## Running the BUILT board (no `tsx watch`)

`pnpm dev` runs the TypeScript sources under `tsx`. A stable/deployed board runs the built
artifact instead — the same thing `npx agentic-kanban` executes:

```bash
pnpm build                                   # shared → server bundle → mcp → worker → client → assets
KANBAN_DB_URL=file:/abs/path/kanban.db \
  pnpm --filter agentic-kanban start         # = node packages/server/dist/cli/index.js dev
```

`start` migrates and seeds the database on first run, so a fresh `KANBAN_DB_URL` needs no
`db:setup`. Two directories resolve differently here than under `tsx`, and both work for the
wrong reason in a dev run, so they are the things to check if a built board misbehaves:

| What | Dev run | Built run |
|---|---|---|
| drizzle migrations | `packages/shared/drizzle` | `packages/server/dist/migrations` (copied by `scripts/copy-assets.mjs`) |
| bundled agent skills | found by walking up from `packages/shared/src/lib` | found by walking up from `dist/` → `packages/server/skills` |

`GET /health` reports the first one: in a built run it answers with a `migrations-journal`
check naming the `dist/migrations` path. `agentic-kanban skill verify` reports the second —
it prints `Bundle: <dir>`, and exits with *"No bundled skills found"* when the `skills/`
directory did not ship.

**Both are verified by `pnpm smoke:boot-dist`** (`scripts/boot-dist-smoke.mjs`, #1012). It
checks HEAD out into a throwaway `git worktree` — `scripts/build-server.mjs` wipes
`packages/server/dist` unconditionally, so it must never be pointed at a checkout you are
using — builds there, boots the built CLI against a temp `KANBAN_DB_URL`, and probes
`/health`, `GET /api/projects`, the applied-migration count and the bundled-skills
resolution, then removes the worktree. `--full` runs the whole `pnpm build` (adds the client
bundle), `--break-skills` is the fault injection that proves the skills check bites, `--keep`
leaves the worktree for inspection. Measured ~19 s. It is **not** part of `pnpm test:mine`:
the vitest wrapper `packages/server/src/__tests__/boot-from-dist-smoke.test.ts` self-skips
unless `KANBAN_BOOT_DIST_SMOKE=1`, because it mutates the shared repo's worktree registry and
holds a real port — fine for a nightly sweep, not for every merge gate.

## Registering other projects

```bash
pnpm cli -- register /path/to/your/repo
```

Detects git metadata and creates a project with 7 default statuses. Switch between projects via the dropdown in the header.

## MCP server

```bash
pnpm --filter @agentic-kanban/mcp-server dev
```

## Desktop app (optional)

Requires Rust + MSVC C++ Build Tools ("Desktop development with C++" workload in Visual Studio Installer):

```bash
pnpm dev:desktop
```

## Troubleshooting

### `EBUSY: resource busy or locked`

The DB is held open by a running server. Stop it first:

```powershell
# Kill only the server port (not all node processes)
$proc = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($proc) { taskkill /F /T /PID $proc }
```

### `SQLITE_ERROR: no such column`

A migration was not applied. Run `pnpm db:migrate` (or `pnpm db:repair` for lock/WAL issues — never delete the DB).

### Port already in use

```powershell
$proc = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($proc) { Stop-Process -Id $proc -Force }
```

---

## Clean-clone / first-start gotchas (Windows)

Work through these in order if the app won't start on a fresh clone.

### 1. `spawn pnpm ENOENT`

**Status: fixed.** The launcher/preflight scripts no longer spawn a bare `pnpm` binary. They re-invoke pnpm through `process.env.npm_execpath` (pnpm's own JS entry, set whenever a script runs under `pnpm run`), with a shell fallback on Windows — see `scripts/pnpm-exec.mjs`. Any pnpm install method (npm -g, corepack, Scoop, standalone) now works; no `pnpm.exe` needed.

If you still see it, pnpm itself is missing from PATH entirely: `corepack enable && corepack prepare pnpm@10.12.1 --activate` (or `scoop install pnpm`).

### 2. Client: `Failed to resolve entry for "@agentic-kanban/shared"`

**Status: fixed.** `vite.config.ts` now prepends the `"development"` condition in serve mode → client resolves `shared` to `src/` without a pre-build. If it recurs: `pnpm --filter @agentic-kanban/shared build`.

### 3. Backend never binds on `:3001` (proxy up, API hangs)

**Symptom:** `[dev-proxy] API proxy listening at http://127.0.0.1:3001 → 13001` is logged but `/api/projects` hangs.

**Cause:** `tsx watch` of the full server hangs on Windows with Node 23.x. Plain `tsx` works; Node LTS 22 avoids the issue.

**Workaround:** run backend without watch (loses hot-reload):

```powershell
# terminal 1 — backend on port 3001 directly
$env:KANBAN_INTERNAL_SERVER_PORT="3001"; $env:SERVER_PORT="3001"
cd packages/server
pnpm exec tsx --conditions development src/index.ts

# terminal 2 — client (Vite proxies /api to SERVER_PORT)
$env:SERVER_PORT="3001"
cd packages/client
pnpm exec vite
```

### 4. `register .` duplicates hooks in the agentic-kanban repo itself

`pnpm db:setup` ends with `pnpm cli -- register .`. On a contributor checkout that appends generic hooks to `.claude/settings.json` (already present) and commits the duplicate. Drop that commit:

```bash
git reset --hard HEAD~1   # main checkout only; DB registration is unaffected
```
