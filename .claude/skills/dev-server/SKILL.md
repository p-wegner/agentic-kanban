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

`scripts/dev.mjs` auto-detects worktree context and sets these env vars: `KANBAN_WORKTREE_SERVER_PORT`, `KANBAN_WORKTREE_CLIENT_PORT`, `SERVER_PORT`, `PORT`, `VITE_PORT`. Agent sessions also keep `KANBAN_SERVER_PORT` pointed at the main board API; do not use it for worktree dev-server cleanup when `KANBAN_WORKTREE_SERVER_PORT` is present.

**In a worktree, never hardcode 3001/5173.** Read the env vars instead:

```powershell
$serverPort = if ($env:KANBAN_WORKTREE_SERVER_PORT) { $env:KANBAN_WORKTREE_SERVER_PORT } elseif ($env:KANBAN_SERVER_PORT) { $env:KANBAN_SERVER_PORT } else { 3001 }
$clientPort = if ($env:KANBAN_WORKTREE_CLIENT_PORT) { $env:KANBAN_WORKTREE_CLIENT_PORT } elseif ($env:KANBAN_CLIENT_PORT) { $env:KANBAN_CLIENT_PORT } else { 5173 }
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

## Step 4 — Stop (kill only this checkout's ports)

Kill only the processes bound to this checkout's `$serverPort` and `$clientPort`. Do **not** kill every `dev.mjs`, every Vite process, or every `agentic-kanban ... src/index.ts` process by command line alone: worktree agents doing visual checks run their own dev servers, and a broad command-line kill can take down the main board server while other agents are still working.

This uses one `netstat` snapshot per port, not a polling loop. When the port owner is a child of `scripts/dev.mjs`, kill the parent with `/T` so its supervised child exits too. Otherwise kill just the port owner tree.

```powershell
$serverPort = if ($env:KANBAN_WORKTREE_SERVER_PORT) { [int]$env:KANBAN_WORKTREE_SERVER_PORT } elseif ($env:KANBAN_SERVER_PORT) { [int]$env:KANBAN_SERVER_PORT } else { 3001 }
$clientPort = if ($env:KANBAN_WORKTREE_CLIENT_PORT) { [int]$env:KANBAN_WORKTREE_CLIENT_PORT } elseif ($env:KANBAN_CLIENT_PORT) { [int]$env:KANBAN_CLIENT_PORT } else { 5173 }

function Stop-PortOwner([int]$port) {
    $lines = netstat -ano | Select-String "[:.]$port\s"
    $pids = $lines |
        ForEach-Object { ($_ -split '\s+')[-1] } |
        Where-Object { $_ -match '^\d+$' -and $_ -ne '0' } |
        Sort-Object -Unique

    foreach ($pid in $pids) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $pid" -ErrorAction SilentlyContinue
        $parent = if ($proc) { Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ParentProcessId)" -ErrorAction SilentlyContinue } else { $null }
        $targetPid = if ($parent -and $parent.CommandLine -like "*dev.mjs*") { $parent.ProcessId } else { [int]$pid }
        taskkill /F /T /PID $targetPid 2>$null
    }
}

Stop-PortOwner $serverPort
Stop-PortOwner $clientPort
```

## Step 5 — Health check

```powershell
$serverPort = if ($env:KANBAN_WORKTREE_SERVER_PORT) { $env:KANBAN_WORKTREE_SERVER_PORT } elseif ($env:KANBAN_SERVER_PORT) { $env:KANBAN_SERVER_PORT } else { 3001 }
try { $r = Invoke-RestMethod "http://localhost:$serverPort/api/projects" -TimeoutSec 10; Write-Host "API OK: $($r.Count) projects" } catch { Write-Host "API FAILED: $_" }
```

A 200 with a project array means server + DB are both healthy. If `/health` responds but `/api/projects` hangs, an orphaned tsx process is holding the DB open — run the STOP step, then restart.
