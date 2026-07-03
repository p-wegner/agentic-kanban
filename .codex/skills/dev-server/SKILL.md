---
name: dev-server
description: Start/stop/health-check the dev server safely — worktree ports, process-signature kills, never kill-all-node
---

# dev-server

Safely start, stop, and health-check a project's dev server. The HARD CONSTRAINTS and the agentic-kanban-specific recipe below are the default; for **any other driven project**, the start command + health URL + port come from the project's stack profile (see "Driving any project").

## Driving any project (per-stack, #790)

The board derives a **dev-server plan** for any project from its stack profile (#786) — `devCommand` → start command, `devHealthUrl` → what to poll, `devPort` → which port to free on teardown — with per-project `dev_command_<projectId>` / `health_url_<projectId>` preference overrides taking precedence. The code lives in `packages/server/src/services/dev-server.service.ts`:

- `resolveProjectDevServerPlan(projectId, db, { workingDir })` → `{ command, healthUrl, port, isWeb }` (or null when nothing can boot). Precedence: `dev_command`/`health_url` prefs → stack profile → (for this app's own worktrees only) the 3001+N/5173+N convention.
- `startDevServer(plan, cwd)` — spawns through the platform shell with **`detached: true` + `windowsHide: true`**, stdio redirected to `tmpdir()/kanban-<label>.log`. Never `Start-Process`.
- `healthCheckDevServer(url)` — in-process HTTP poll (any status < 500 = up; a 404 still proves the port bound). NOT a `netstat`/`Get-NetTCPConnection` loop.
- `stopDevServer(plan)` — kills **only** the listener on the resolved port via `killProcessesOnPorts` (exact port, guard-protected) — never all node, never a range.

So a node web app, a python service, a go server, etc. can each be booted + health-checked headlessly. The hard constraints below apply to every project; the PowerShell recipe in Steps 1–5 is the agentic-kanban-specific instance of it.

## HARD CONSTRAINTS (read first)

- **NEVER kill ALL node processes.** Other agents run dev servers in separate worktrees on different ports; a blanket `Stop-Process -Name node` kills their work. Always kill by *process signature* (port owner) — see STOP.
- **NEVER use `Start-Process`** — it flashes terminal windows on Windows. Use the Bash tool (`nohup`/`disown`), `Invoke-Expression`, or `&`. When spawning from Node, always pass `windowsHide: true`.
- **NEVER poll with `Get-NetTCPConnection` / `netstat | findstr` in a loop** — each iteration spawns a subprocess that flashes a window. Use one snapshot for port checks. (Polling the HTTP endpoint to wait for *bind* is the exception — see Step 3b.)
- **NEVER use `curl`** for health checks — it's an alias for `Invoke-WebRequest` and breaks JSON. Use `Invoke-RestMethod`.

## Step 0 — Bootstrap (first-run check)

**Run this before Step 1 when helping a new user or when the DB might not exist.**

**0a — Check DB; initialize if missing:**
```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
DB_PATH="$REPO_ROOT/packages/server/kanban.db"
if [ ! -f "$DB_PATH" ]; then
  echo "No DB — running db:setup (migrate + seed + register)..."
  cd "$REPO_ROOT" && pnpm db:setup
fi
```

`pnpm db:setup` = migrate + seed default tags/skills + register the current repo as a project. `pnpm install` (with the `prepare` script in `packages/shared`) auto-builds `shared/dist` so the CLI works immediately.

**0b — After the server is up (Step 3 complete), check project registration:**
```powershell
$r = Invoke-RestMethod "http://127.0.0.1:$serverPort/api/projects" -TimeoutSec 5
if ($r.Count -eq 0) {
  Write-Host "No projects registered — registering current repo..."
  # Run from the main checkout (not a worktree):
  pnpm cli -- register .
}
```

If it's unclear which repo to register (user said "start the app" with CWD unknown), ask before running `register`.

## Step 1 — Determine ports

`scripts/dev.mjs` auto-detects worktree context and sets `KANBAN_WORKTREE_SERVER_PORT`, `KANBAN_WORKTREE_CLIENT_PORT`, `KANBAN_SERVER_PORT`, `KANBAN_CLIENT_PORT`, `SERVER_PORT`, `PORT`, `VITE_PORT`. (Worktree board REST calls use `KANBAN_BOARD_SERVER_PORT`; dev-server cleanup uses the worktree ports.) **In a worktree, never hardcode 3001/5173** — read the env vars. Later steps reuse `$serverPort`/`$clientPort` from here:

```powershell
$serverPort = if ($env:KANBAN_WORKTREE_SERVER_PORT) { [int]$env:KANBAN_WORKTREE_SERVER_PORT } elseif ($env:KANBAN_SERVER_PORT) { [int]$env:KANBAN_SERVER_PORT } else { 3001 }
$clientPort = if ($env:KANBAN_WORKTREE_CLIENT_PORT) { [int]$env:KANBAN_WORKTREE_CLIENT_PORT } elseif ($env:KANBAN_CLIENT_PORT) { [int]$env:KANBAN_CLIENT_PORT } else { 5173 }
```

Deterministic scheme: **main checkout** server `3001` / client `5173`; **worktree on `feature/<N>-…`** (or `feature/ak-<N>-…`) `3001+N` / `5173+N`; **non-standard branch** `3001+hash` / `5173+hash` (hash 101–1000 from the branch name).

## Step 2 — Check if already running

**One** HTTP check, no loop — if it succeeds, skip the start step:

```powershell
try { $r = Invoke-RestMethod "http://127.0.0.1:$serverPort/api/projects" -TimeoutSec 5; Write-Host "Already running: $($r.Count) projects" } catch { Write-Host "Not running" }
```

## Step 3 — Start (two steps)

**3a — Bash tool: launch and detach.** Use `nohup` + `disown` so it survives the Bash session exiting (a plain `&` gets SIGHUP and dies):
```bash
nohup pnpm dev > /tmp/kanban-dev.log 2>&1 &
disown
echo "Started PID: $!"
```
(Not `Start-Job` — when PowerShell exits, the job and children die. Not `Start-Process` — flashes windows. `nohup`/`disown` is the only reliable detach.)

**3b — PowerShell (`run_in_background: true`): poll HTTP until it binds.**
```powershell
$ok = $false
foreach ($i in 1..20) {
  Start-Sleep -Seconds 2
  try { $r = Invoke-RestMethod "http://127.0.0.1:$serverPort/api/projects" -TimeoutSec 3; Write-Host "API OK after $($i*2)s: $($r.Count) projects"; $ok = $true; break } catch {}
}
if (-not $ok) { Write-Host "API FAILED to bind within 40s" }
```

**HTTP polling is fine — port-scan polling is not.** The HARD CONSTRAINT ban is specifically on `Get-NetTCPConnection`/`netstat`/`Start-Process` loops (each spawns a window-flashing subprocess). An `Invoke-RestMethod` loop is an in-process .NET HTTP call — no subprocess, no window — and is correct here: a cold start binds slower than any constant sleep, so a blind `Start-Sleep 15` then "check once" races the bind and makes every later REST call fail with connection-refused. If the endpoint never answers in the window, report it and read `/tmp/kanban-dev.log` — do not fall back to a port-scan loop.

## Step 4 — Stop (kill only this checkout's ports)

Kill only the processes bound to this checkout's ports. Do **not** kill every `dev.mjs`/Vite/`agentic-kanban … src/index.ts` by command line alone — worktree agents run their own dev servers and a broad kill takes down the main board server while others work.

**Two things bite if you only kill `$serverPort`/`$clientPort` (and they did — a stale backend then kept serving the wrong DB on the next launch, and the restart died with `EADDRINUSE`):**

1. **The backend lives on a separate INTERNAL port.** `$serverPort` (3001) is just the `server-dev-proxy.mjs` proxy; it forwards to the real backend (the `tsx … src/index.ts` process that holds the DB open) on `$serverPort ± 10000` (3001→13001; worktree `3001+N`→`13001+N`). Killing only 3001/5173 leaves that backend alive, so the next `pnpm dev`'s new proxy connects to the OLD backend (old DB) and/or the new one fails to bind. **You must stop the backend port too.**
2. **`scripts/dev.mjs` is a SUPERVISOR that respawns killed children.** Killing the port owner alone makes the port reappear within ~1s. You must kill the **`dev.mjs` ancestor** with `/T` — and it's usually a *grand*parent (chain: `dev.mjs` → `pnpm` → `node` proxy / `tsx watch` → backend), so checking only the owner's immediate parent misses it. Walk the full ancestry. Starting from *this checkout's* port owner keeps the walk scoped to this checkout — you'll only ever reach this checkout's single `dev.mjs`, never a worktree's.

One `netstat` snapshot per port (no loop). Killing the `dev.mjs` root with `/T` cascades to all its children (proxy + vite + backend) in one shot.

```powershell
# Backend internal port (proxy forwards to it). Mirror server-dev-proxy.mjs.
$backendPort = if ($serverPort -le 55535) { $serverPort + 10000 } else { $serverPort - 10000 }

function Stop-PortOwner([int]$port) {
    $lines = netstat -ano | Select-String "[:.]$port\s"
    $pids = $lines | ForEach-Object { ($_ -split '\s+')[-1] } |
        Where-Object { $_ -match '^\d+$' -and $_ -ne '0' } | Sort-Object -Unique
    # NOTE: do not name a loop var $pid — $PID is a read-only automatic variable; assigning throws.
    foreach ($ownerPid in $pids) {
        # Climb the parent chain (bounded) to the scripts/dev.mjs supervisor so it can't
        # respawn the child. The walk is checkout-scoped: it begins at THIS checkout's
        # port owner, so the only dev.mjs it can reach is THIS checkout's supervisor.
        $targetPid = [int]$ownerPid
        $cursor = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue
        for ($depth = 0; $depth -lt 8 -and $cursor; $depth++) {
            if ($cursor.CommandLine -like "*dev.mjs*") { $targetPid = $cursor.ProcessId }
            $cursor = Get-CimInstance Win32_Process -Filter "ProcessId = $($cursor.ParentProcessId)" -ErrorAction SilentlyContinue
        }
        taskkill /F /T /PID $targetPid 2>$null | Out-Null
    }
}
Stop-PortOwner $serverPort
Stop-PortOwner $backendPort
Stop-PortOwner $clientPort

# Verify the supervisor didn't respawn anything — a single snapshot (NOT a loop).
Start-Sleep -Seconds 1
$still = Get-NetTCPConnection -State Listen -LocalPort $serverPort,$backendPort,$clientPort -ErrorAction SilentlyContinue
if ($still) { Write-Host "WARNING: still listening on $($still.LocalPort -join ', ') — a dev.mjs supervisor likely respawned; re-run STOP." }
else { Write-Host "Stopped: $serverPort/$backendPort/$clientPort all free." }
```

## Step 5 — Health check

```powershell
try { $r = Invoke-RestMethod "http://127.0.0.1:$serverPort/api/projects" -TimeoutSec 10; Write-Host "API OK: $($r.Count) projects" } catch { Write-Host "API FAILED: $_" }
```

A 200 with a project array means server + DB are both healthy. If `/health` responds but `/api/projects` hangs, an orphaned tsx process is holding the DB open — run STOP, then restart.
