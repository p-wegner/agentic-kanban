---
name: dev-server
description: Start/stop/health-check the dev server safely — worktree ports, process-signature kills, never kill-all-node
---

# dev-server

Safely start, stop, and health-check the agentic-kanban dev server. This encodes the project's exact (easy-to-get-wrong) process and port logic. Follow it verbatim — the failure modes below are dangerous on Windows and to other agents.

## HARD CONSTRAINTS (read first)

- **NEVER kill ALL node processes.** Other agents run dev servers in separate worktrees on different ports. A blanket `Stop-Process -Name node` kills their work. Always kill by *process signature* (command-line match) — see STOP below.
- **NEVER use `Start-Process`.** It flashes terminal windows on Windows. Use the Bash tool (`nohup`/`disown`), `Invoke-Expression`, or `&` instead. When spawning processes in Node.js, always pass `windowsHide: true`.
- **NEVER poll with `Get-NetTCPConnection` (or `netstat | findstr`) in a loop.** Each iteration spawns a subprocess that flashes a terminal window. Use a *single fixed delay + one check*.
- **NEVER use `curl`** for health checks — it's an alias for `Invoke-WebRequest` and breaks JSON. Use `Invoke-RestMethod`.

## Step 1 — Determine ports

`scripts/dev.mjs` auto-detects worktree context and sets these env vars: `KANBAN_SERVER_PORT`, `KANBAN_CLIENT_PORT`, `SERVER_PORT`, `PORT`, `VITE_PORT`.

**In a worktree, never hardcode 3001/5173.** Read the env vars instead:

```powershell
$serverPort = if ($env:KANBAN_SERVER_PORT) { $env:KANBAN_SERVER_PORT } else { 3001 }
$clientPort = if ($env:KANBAN_CLIENT_PORT) { $env:KANBAN_CLIENT_PORT } else { 5173 }
```

Deterministic port scheme:
- **Main checkout**: server `3001`, client `5173`.
- **Worktree on `feature/<N>-...`** (or `feature/ak-<N>-...`): server `3001+N`, client `5173+N` (N = issue number).
- **Worktree on a non-standard branch**: server `3001+hash`, client `5173+hash` (hash in range 101–1000, computed from the branch name).

## Step 2 — Check if already running (before starting)

Do this with **one** HTTP check — do not loop. If it succeeds, the server is up; skip the start step.

```powershell
try { $r = Invoke-RestMethod "http://localhost:$serverPort/api/projects" -TimeoutSec 5; Write-Host "Already running: $($r.Count) projects" } catch { Write-Host "Not running" }
```

## Step 3 — Start (two steps, no polling)

**Step 3a — Bash tool: launch and detach.**

```bash
nohup pnpm dev > /tmp/kanban-dev.log 2>&1 &
disown
echo "Started PID: $!"
```

Use `nohup` + `disown` so the process survives the Bash session exiting (a plain `&` gets SIGHUP when the shell exits and the server dies).

**Step 3b — PowerShell tool (`run_in_background: true`): single fixed delay, then one HTTP check.**

```powershell
Start-Sleep -Seconds 15
try { $r = Invoke-RestMethod "http://localhost:3001/api/projects" -TimeoutSec 10; Write-Host "API OK: $($r.Count) projects" } catch { Write-Host "API FAILED: $_" }
```

(Substitute `$serverPort` for `3001` when in a worktree.)

Why **not** `Start-Job`: when PowerShell exits, the job and all its children die. Why **not** `Start-Process`: flashes terminal windows. The `nohup`/`disown` Bash launch is the only reliable detach.

If the server isn't up after the single check, report it and let the user retry. Do **not** add a retry loop.

## Step 4 — Stop (kill by process signature)

Kills the main dev launcher, both vite clients, and any dangling worktree servers — without touching unrelated node processes. Also kills orphaned tsx server processes that hold the SQLite DB open (these cause `/api/projects` to hang even when `/health` responds).

```powershell
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -like "*dev.mjs*" } |
    ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>$null }
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*vite/bin/vite.js*" } |
    ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>$null }
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -like "*agentic-kanban*tsx*src/index*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
```

## Step 5 — Health check

```powershell
$serverPort = if ($env:KANBAN_SERVER_PORT) { $env:KANBAN_SERVER_PORT } else { 3001 }
try { $r = Invoke-RestMethod "http://localhost:$serverPort/api/projects" -TimeoutSec 10; Write-Host "API OK: $($r.Count) projects" } catch { Write-Host "API FAILED: $_" }
```

A 200 with a project array means server + DB are both healthy. If `/health` responds but `/api/projects` hangs, an orphaned tsx process is holding the DB open — run the STOP step, then restart.
