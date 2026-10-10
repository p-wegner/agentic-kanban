# ak-worker-run.ps1 - the supervised wrapper a Scheduled Task runs.
#
# Not meant to be called by hand; use ak-worker-service.ps1 -Install/-Start.
#
# Everything here exists because a Scheduled Task starts with a MINIMAL
# environment - it does not inherit an interactive shell's. That is the point
# rather than an inconvenience:
#
#   ACP_AUTOCONNECT=0  A worker's agents are headless. acp checks this variable
#                      BEFORE its headless guard, so an inherited "1" forces
#                      auto-connect on, leaves a detached child alive, and hangs
#                      the agent forever with no output (it wedged two fleet
#                      dispatches on 2026-08-20). Set explicitly, never inherited.
#   CLAUDE_CONFIG_DIR  Decides WHICH account runs the work. Unset falls back to
#                      ~/.claude - on this machine the personal login rather than
#                      the work one, with an identical registration and nothing
#                      board-visible to tell them apart.
#   PATH               The npm global bin is often absent from a task's PATH, so
#                      the worker binary is resolved explicitly below.
#
# Writes one UTC-stamped line per daemon line, so a log can be read for state
# (the daemon itself stamps nothing). Restarts the daemon with backoff: the board
# is a dev server that restarts often, and a worker that exits on the first
# dropped socket is not a service.

[CmdletBinding()]
param(
  [string]$ConfigFile = (Join-Path $env:LOCALAPPDATA 'agentic-kanban-worker\config.json')
)

$ErrorActionPreference = 'Stop'

function Write-Log {
  param([string]$Text, [string]$LogFile)
  $line = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $Text
  try { Add-Content -Path $LogFile -Value $line -Encoding utf8 } catch { }
}

if (-not (Test-Path $ConfigFile)) {
  throw "no config at $ConfigFile - run ak-worker-service.ps1 -Install first"
}
$cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json

$stateDir = Split-Path $ConfigFile -Parent
$log = Join-Path $stateDir 'worker.log'
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }

# Keep the log bounded; the tray only ever reads the tail.
try {
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt 4MB)) {
    Move-Item $log "$log.1" -Force
  }
} catch { }

# --- the two variables that decide correctness, set rather than inherited ---
$env:ACP_AUTOCONNECT = '0'
if ($cfg.claudeConfigDir) { $env:CLAUDE_CONFIG_DIR = $cfg.claudeConfigDir }
# A human's live session id must never reach a fleet agent.
foreach ($v in 'CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_CHILD_SESSION','CLAUDECODE','CLAUDE_PID','CLAUDE_CODE_ENTRYPOINT') {
  Remove-Item "Env:\$v" -ErrorAction SilentlyContinue
}

# --- resolve the worker binary; a task's PATH usually lacks the npm global bin ---
$exe = $null
if ($cfg.workerCmd -and (Test-Path $cfg.workerCmd)) { $exe = $cfg.workerCmd }
if (-not $exe) {
  $cmd = Get-Command agentic-kanban-worker -ErrorAction SilentlyContinue
  if ($cmd) { $exe = $cmd.Source }
}
if (-not $exe) {
  try {
    $prefix = (& npm prefix -g 2>$null)
    if ($prefix) {
      $cand = Join-Path $prefix.Trim() 'agentic-kanban-worker.cmd'
      if (Test-Path $cand) { $exe = $cand }
    }
  } catch { }
}
if (-not $exe) {
  Write-Log "[run] FATAL: agentic-kanban-worker not found (config.workerCmd, PATH, npm prefix -g all failed)" $log
  exit 1
}

$argList = @(
  'start',
  '--board', $cfg.board,
  '--name', $cfg.name,
  '--labels', $cfg.labels,
  '--providers', $cfg.providers,
  '--max-concurrency', [string]$cfg.maxConcurrency
)
if ($cfg.autoUpdate) { $argList += '--auto-update' }

# --- self-update (#1338) ---------------------------------------------------------------
# The daemon installs a new build into <worker-home>\versions\<build> (NEVER over the package it
# is running from - that fails or half-installs on Windows, files in use), records it in
# versions\current.json and exits with code 75. This loop then relaunches on the newest
# installed version instead of the global binary. worker-home is the directory of the worker
# state file, which the daemon defaults to ~\.agentic-kanban.
$UpdateExitCode = 75
$versionsDir = Join-Path (Join-Path $HOME '.agentic-kanban') 'versions'
# Tells the daemon a supervisor will relaunch it, so it exits 75 instead of spawning itself.
$env:KANBAN_WORKER_SUPERVISED = '1'

function Get-VersionPointer {
  $p = Join-Path $versionsDir 'current.json'
  if (-not (Test-Path $p)) { return $null }
  try { return (Get-Content $p -Raw | ConvertFrom-Json) } catch { return $null }
}

# A switched build that restarts again and again without ever connecting is rolled back here
# too (the daemon has the same guard for the starts that reach its own code): pending.json
# is deleted once the new build connects, and its `attempts` counts the starts since the switch.
function Invoke-PendingRollbackIfStuck {
  $pendingFile = Join-Path $versionsDir 'pending.json'
  if (-not (Test-Path $pendingFile)) { return }
  try { $pending = Get-Content $pendingFile -Raw | ConvertFrom-Json } catch { return }
  if ([int]$pending.attempts -lt 3 -or -not $pending.previousEntry) { return }
  Write-Log "[run] build $($pending.buildId) restarted $($pending.attempts) times without connecting; rolling back to $($pending.previousEntry)" $log
  $prev = @{ buildId = [string]$pending.previousBuildId; entry = [string]$pending.previousEntry } | ConvertTo-Json
  [System.IO.File]::WriteAllText((Join-Path $versionsDir 'current.json'), $prev, (New-Object System.Text.UTF8Encoding($false)))
  $fail = @{ buildId = [string]$pending.buildId; reason = "started $($pending.attempts) times without connecting"; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json
  [System.IO.File]::WriteAllText((Join-Path $versionsDir 'last-update.json'), $fail, (New-Object System.Text.UTF8Encoding($false)))
  Remove-Item $pendingFile -Force -ErrorAction SilentlyContinue
}

# The command line for this launch: the newest installed version when one is recorded and still
# on disk, else the globally installed binary resolved above.
function Resolve-Launch {
  Invoke-PendingRollbackIfStuck
  $ptr = Get-VersionPointer
  if ($ptr -and $ptr.entry -and (Test-Path $ptr.entry)) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) { return @{ exe = $node.Source; pre = @([string]$ptr.entry); label = "version $($ptr.buildId) ($($ptr.entry))" } }
  }
  return @{ exe = $exe; pre = @(); label = "installed binary $exe" }
}

Write-Log "[run] supervisor starting: $exe (board $($cfg.board), name $($cfg.name), CLAUDE_CONFIG_DIR=$($env:CLAUDE_CONFIG_DIR)) ACP_AUTOCONNECT=0 autoUpdate=$([bool]$cfg.autoUpdate)" $log

$delay = 2
while ($true) {
  $started = Get-Date
  $launch = Resolve-Launch
  Write-Log "[run] launching $($launch.label)" $log
  $exitCode = 0
  try {
    # 2>&1 merges the daemon's stderr so a crash reason reaches the log rather
    # than being discarded; every line is stamped as it arrives.
    & $launch.exe @($launch.pre) @argList 2>&1 | ForEach-Object { Write-Log $_ $log }
    $exitCode = $LASTEXITCODE
  } catch {
    Write-Log "[run] daemon threw: $($_.Exception.Message)" $log
  }
  if ($exitCode -eq $UpdateExitCode) {
    # A planned handover to a freshly installed build: no backoff, no crash accounting.
    Write-Log "[run] daemon exited $UpdateExitCode (self-update); relaunching on the newest installed version" $log
    $delay = 2
    Start-Sleep -Seconds 1
    continue
  }
  $ranFor = [int]((Get-Date) - $started).TotalSeconds
  # A daemon that survived a while was healthy; reset the backoff so a normal
  # board restart does not push us toward a 5-minute sleep.
  if ($ranFor -ge 60) { $delay = 2 }
  Write-Log "[run] daemon exited after ${ranFor}s; restarting in ${delay}s" $log
  Start-Sleep -Seconds $delay
  $delay = [Math]::Min($delay * 2, 300)
}
