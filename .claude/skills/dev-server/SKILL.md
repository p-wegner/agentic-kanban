---
name: dev-server
description: Start/stop/health-check the dev server safely — worktree ports, process-signature kills, never kill-all-node
---

# dev-server

Safely start, stop, and health-check the agentic-kanban dev server. This encodes the project's exact (easy-to-get-wrong) process and port logic — follow it verbatim. The failure modes below are dangerous on Windows and to other agents.

## HARD CONSTRAINTS (read first)

- **NEVER kill ALL node processes.** Other agents run dev servers in separate worktrees on different ports; a blanket `Stop-Process -Name node` kills their work. Always kill by *process signature* (port owner) — see STOP.
- **NEVER use `Start-Process`** — it flashes terminal windows on Windows. Use the Bash tool (`nohup`/`disown`), `Invoke-Expression`, or `&`. When spawning from Node, always pass `windowsHide: true`.
- **NEVER poll with `Get-NetTCPConnection` / `netstat | findstr` in a loop** — each iteration spawns a subprocess that flashes a window. Use one snapshot for port checks. (Polling the HTTP endpoint to wait for *bind* is the exception — see Step 3b.)
- **NEVER use `curl`** for health checks — it's an alias for `Invoke-WebRequest` and breaks JSON. Use `Invoke-RestMethod`.

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

Kill only the processes bound to this checkout's `$serverPort`/`$clientPort` (set in Step 1). Do **not** kill every `dev.mjs`/Vite/`agentic-kanban … src/index.ts` by command line alone — worktree agents run their own dev servers and a broad kill takes down the main board server while others work. One `netstat` snapshot per port (no loop); when the port owner is a child of `scripts/dev.mjs`, kill the parent with `/T` so its supervised child exits too, else kill just the owner tree.

```powershell
function Stop-PortOwner([int]$port) {
    $lines = netstat -ano | Select-String "[:.]$port\s"
    $pids = $lines | ForEach-Object { ($_ -split '\s+')[-1] } |
        Where-Object { $_ -match '^\d+$' -and $_ -ne '0' } | Sort-Object -Unique
    # NOTE: do not name this loop var $pid — $PID is a read-only automatic variable; assigning throws.
    foreach ($ownerPid in $pids) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue
        $parent = if ($proc) { Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ParentProcessId)" -ErrorAction SilentlyContinue } else { $null }
        $targetPid = if ($parent -and $parent.CommandLine -like "*dev.mjs*") { $parent.ProcessId } else { [int]$ownerPid }
        taskkill /F /T /PID $targetPid 2>$null
    }
}
Stop-PortOwner $serverPort
Stop-PortOwner $clientPort
```

## Step 5 — Health check

```powershell
try { $r = Invoke-RestMethod "http://127.0.0.1:$serverPort/api/projects" -TimeoutSec 10; Write-Host "API OK: $($r.Count) projects" } catch { Write-Host "API FAILED: $_" }
```

A 200 with a project array means server + DB are both healthy. If `/health` responds but `/api/projects` hangs, an orphaned tsx process is holding the DB open — run STOP, then restart.
