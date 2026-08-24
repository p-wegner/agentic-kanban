# ak-worker-service.ps1 - run the agentic-kanban fleet worker as a background
# service that survives the session that started it.
#
#   .\ak-worker-service.ps1 -Install -Board http://100.105.24.76:3003 [-Name ...]
#   .\ak-worker-service.ps1 -Start | -Stop | -Restart | -Status | -Log | -Uninstall
#
# A Scheduled Task at logon, NOT a Windows service. The worker runs agents with
# THIS user's provider credentials (the board deliberately sends none), so it has
# to live in the user's session; a service running as SYSTEM or a service account
# would have no `claude` login at all. -Install therefore needs no admin rights.
#
# The task runs ak-worker-run.ps1, which supervises the daemon and sets the two
# variables a fresh environment would otherwise get wrong (ACP_AUTOCONNECT=0 and
# CLAUDE_CONFIG_DIR). See the header there for why each one matters.

[CmdletBinding(DefaultParameterSetName = 'Status')]
param(
  [Parameter(ParameterSetName = 'Install', Mandatory = $true)][switch]$Install,
  [Parameter(ParameterSetName = 'Install')][string]$Board,
  [Parameter(ParameterSetName = 'Install')][string]$Name = $env:COMPUTERNAME,
  [Parameter(ParameterSetName = 'Install')][string]$Labels = 'windows',
  [Parameter(ParameterSetName = 'Install')][string]$Providers = 'claude',
  [Parameter(ParameterSetName = 'Install')][int]$MaxConcurrency = 2,
  [Parameter(ParameterSetName = 'Install')][string]$ClaudeConfigDir = $env:CLAUDE_CONFIG_DIR,
  [Parameter(ParameterSetName = 'Install')][switch]$NoStart,
  [Parameter(ParameterSetName = 'Install')][switch]$Force,

  [Parameter(ParameterSetName = 'Uninstall', Mandatory = $true)][switch]$Uninstall,
  [Parameter(ParameterSetName = 'Uninstall')][switch]$UninstallForce,
  [Parameter(ParameterSetName = 'Start',     Mandatory = $true)][switch]$Start,
  [Parameter(ParameterSetName = 'Stop',      Mandatory = $true)][switch]$Stop,
  [Parameter(ParameterSetName = 'Stop')][switch]$StopForce,
  [Parameter(ParameterSetName = 'Restart',   Mandatory = $true)][switch]$Restart,
  [Parameter(ParameterSetName = 'Restart')][switch]$RestartForce,
  [Parameter(ParameterSetName = 'Status',    Mandatory = $false)][switch]$Status,
  [Parameter(ParameterSetName = 'Log',       Mandatory = $true)][switch]$Log,
  [Parameter(ParameterSetName = 'Log')][int]$Tail = 30
)

$ErrorActionPreference = 'Stop'
$TaskName  = 'AgenticKanbanWorker'
$StateDir  = Join-Path $env:LOCALAPPDATA 'agentic-kanban-worker'
$ConfigFile = Join-Path $StateDir 'config.json'
$LogFile   = Join-Path $StateDir 'worker.log'
$RunScript = Join-Path $PSScriptRoot 'ak-worker-run.ps1'

function Get-Task { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }

function Get-WorkerProcess {
  # The daemon is a node process whose command line names the worker bin; the
  # supervisor is the powershell running ak-worker-run.ps1. Report both, because
  # "supervisor up, daemon down" is a real and interesting state (backoff).
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='powershell.exe'" -ErrorAction SilentlyContinue
  [pscustomobject]@{
    Supervisor = $procs | Where-Object { $_.CommandLine -like '*ak-worker-run.ps1*' } | Select-Object -First 1
    Daemon     = $procs | Where-Object { $_.CommandLine -like '*agentic-kanban*' -and $_.CommandLine -like '*worker*' -and $_.CommandLine -notlike '*ak-worker-run.ps1*' } | Select-Object -First 1
  }
}

function Get-WorkerState {
  # Derived from the log tail, because the daemon exposes no status endpoint and
  # the board's worker list is loopback-only by design (see decision 012) - so
  # this machine genuinely cannot ask the board how it looks from there.
  $state = [ordered]@{
    Task = 'not installed'; Supervisor = $false; Daemon = $false
    Connection = 'unknown'; Since = $null; RunningSessions = 0; RunningSessionIds = @()
    OrphanedSessionIds = @(); LastLine = $null; Board = $null
  }
  $t = Get-Task
  if ($t) { $state.Task = (Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult; $state.Task = $t.State }
  $p = Get-WorkerProcess
  $state.Supervisor = [bool]$p.Supervisor
  $state.Daemon = [bool]$p.Daemon
  if (Test-Path $ConfigFile) {
    try { $state.Board = (Get-Content $ConfigFile -Raw | ConvertFrom-Json).board } catch { }
  }
  if (Test-Path $LogFile) {
    $lines = Get-Content $LogFile -Tail 400 -ErrorAction SilentlyContinue
    if ($lines) {
      $state.LastLine = $lines[-1]
      # Which sessions are in flight, and are they REALLY. A count alone tells an
      # operator to stop but not what they are about to destroy.
      #
      # THE PID IS LOAD-BEARING, not decoration. A session killed without logging
      # `agent exited` -- which is what happens whenever the daemon is stopped
      # under it -- stays "launched" in this log forever. Counting log lines alone
      # therefore makes the guard permanently refuse on a machine that has ever
      # lost a session that way, which is the failure it exists to prevent
      # happening again. Measured: this worker showed 3 in flight when 1 was real
      # and 2 were zombies from an earlier forced restart.
      $ids = @{}
      foreach ($l in $lines) {
        if ($l -match 'launched agent: sessionId=([0-9a-f-]{8,}) pid=(\d+)') { $ids[$Matches[1]] = [int]$Matches[2] }
        if ($l -match 'agent exited: sessionId=([0-9a-f-]{8,})')             { $ids.Remove($Matches[1]) }
      }
      $live = @(); $zombie = @()
      foreach ($kv in $ids.GetEnumerator()) {
        if (Get-Process -Id $kv.Value -ErrorAction SilentlyContinue) { $live += $kv.Key } else { $zombie += $kv.Key }
      }
      $state.RunningSessionIds = $live
      $state.RunningSessions = $live.Count
      # Surfaced rather than swallowed: a zombie means work was lost and the board
      # was never told, which is worth an operator seeing even though it does not
      # block anything.
      $state.OrphanedSessionIds = $zombie
      $conn = $lines | Where-Object { $_ -match 'connected to|disconnected|socket error' } | Select-Object -Last 1
      if ($conn) {
        $state.Connection = if ($conn -match 'connected to') { 'connected' } else { 'disconnected' }
        if ($conn -match '^(\d{4}-\d{2}-\d{2}T[\d:]+Z)') { $state.Since = $Matches[1] }
      }
    }
  }
  [pscustomobject]$state
}

# Refuse to interrupt a worker that is mid-dispatch, unless the operator says so.
#
# WHY THIS EXISTS: raising -MaxConcurrency means re-running -Install, which
# restarts the daemon, which kills every running agent. That happened -- two
# dispatched sessions were destroyed by an operator adding capacity, and neither
# logged an `agent exited`, so the board was never told. From its side they simply
# stopped emitting, indistinguishable from work still in progress.
#
# The trap is that the destructive path was also the ONLY path: maxConcurrency is
# accepted at registration and nowhere else, so "add capacity" and "kill the work"
# were the same command, and it printed nothing but "config written" and "started".
#
# So this refuses by default and names the sessions. -Force keeps the old
# behaviour for when that is genuinely what you want (a wedged daemon, a machine
# going down anyway) -- the point is to make destroying live work deliberate
# rather than a side effect of routine maintenance.
function Assert-SafeToInterrupt {
  param([string]$Action, [switch]$Force)
  $s = Get-WorkerState
  if ($s.OrphanedSessionIds.Count -gt 0) {
    Write-Warning "$($s.OrphanedSessionIds.Count) session(s) in the log never logged an exit and their process is gone - work already lost, board never told:"
    foreach ($id in $s.OrphanedSessionIds) { Write-Warning "    $id" }
  }
  if ($s.RunningSessions -le 0) { return }
  if ($Force) {
    Write-Warning "$Action with $($s.RunningSessions) session(s) in flight - forced. They will be killed and the board will NOT be told:"
    foreach ($id in $s.RunningSessionIds) { Write-Warning "    $id" }
    return
  }
  $lines = @(
    "REFUSING TO $($Action.ToUpper()): $($s.RunningSessions) dispatched session(s) are running on this worker."
    ""
  )
  foreach ($id in $s.RunningSessionIds) { $lines += "    $id" }
  $lines += @(
    ""
    "Interrupting now kills those agents. They log no 'agent exited', so the board is"
    "never told: from its side the sessions just stop emitting, and their work is lost"
    "with no error anywhere."
    ""
    "Wait for them to finish (watch: .\ak-worker-service.ps1 -Status, or the tray's"
    "'Open dashboard (live)'), or pass -Force if you mean to destroy them."
  )
  throw ($lines -join [Environment]::NewLine)
}

function Show-Status {
  $s = Get-WorkerState
  Write-Output "task       : $($s.Task)"
  Write-Output "supervisor : $(if ($s.Supervisor) { 'running' } else { 'stopped' })"
  Write-Output "daemon     : $(if ($s.Daemon) { 'running' } else { 'stopped' })"
  Write-Output "board      : $($s.Board)"
  Write-Output "connection : $($s.Connection)$(if ($s.Since) { " (since $($s.Since))" })"
  Write-Output "sessions   : $($s.RunningSessions) in flight"
  if ($s.LastLine) { Write-Output "last log   : $($s.LastLine)" }
  Write-Output "log file   : $LogFile"
}

switch ($PSCmdlet.ParameterSetName) {

  'Install' {
    # -Install re-registers the task and (unless -NoStart) starts it, which stops
    # the running instance. Guard it even with -NoStart: Register-ScheduledTask
    # -Force replaces a task whose instance is currently running.
    Assert-SafeToInterrupt -Action 'reinstall' -Force:$Force
    if (-not $Board) { throw "-Board is required, e.g. -Board http://100.105.24.76:3003 (the FLEET port, not the board API)" }
    if (-not (Test-Path $RunScript)) { throw "missing $RunScript" }
    if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }

    # Resolve the binary NOW and record it: the task's PATH will not have the npm
    # global bin, and failing at install time is far kinder than failing silently
    # at logon three weeks later.
    $workerCmd = $null
    $cmd = Get-Command agentic-kanban-worker -ErrorAction SilentlyContinue
    if ($cmd) { $workerCmd = $cmd.Source }
    if (-not $workerCmd) { throw "agentic-kanban-worker is not on PATH - install it first (see ak-worker.ps1)" }

    if (-not $ClaudeConfigDir) {
      Write-Warning "CLAUDE_CONFIG_DIR is not set and none was passed. The worker will run agents under the DEFAULT profile (~/.claude), which may be a different account than you expect. Pass -ClaudeConfigDir to pin it."
    }

    # WRITE UTF-8 WITHOUT A BOM (#864). `Set-Content -Encoding utf8` on Windows
    # PowerShell 5.1 emits a BOM, and this file is read by more than PowerShell:
    # ConvertFrom-Json tolerates the BOM, but JSON.parse throws on it, so every
    # Node reader of this config silently got no board and no name. Found when the
    # dashboard reported a connected worker with a null board. WriteAllText with an
    # explicit UTF8Encoding($false) is the only reliable no-BOM write in 5.1 --
    # Out-File and Set-Content both re-add it.
    $json = @{
      board = $Board; name = $Name; labels = $Labels; providers = $Providers
      maxConcurrency = $MaxConcurrency; claudeConfigDir = $ClaudeConfigDir
      workerCmd = $workerCmd
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText($ConfigFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "config written: $ConfigFile"

    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
      -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RunScript`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    # Restart-on-failure is the supervisor's job, not the scheduler's; the task
    # only has to exist and start. StopIfGoingOnBatteries would suspend a worker
    # on an unplugged laptop, which looks exactly like the silent-idle failure
    # this whole exercise was about.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
      -Description 'agentic-kanban fleet worker (supervised; runs as the logged-on user so agents use this account credentials)' `
      -Force | Out-Null
    Write-Output "scheduled task '$TaskName' registered (at logon, user $env:USERNAME)"

    if (-not $NoStart) {
      Start-ScheduledTask -TaskName $TaskName
      Write-Output "started"
    }
    break
  }

  'Uninstall' {
    Assert-SafeToInterrupt -Action 'uninstall' -Force:$UninstallForce
    if (Get-Task) {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
      Write-Output "task '$TaskName' removed"
    } else { Write-Output "task '$TaskName' was not installed" }
    $p = Get-WorkerProcess
    foreach ($proc in @($p.Supervisor, $p.Daemon)) {
      if ($proc) { try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop; Write-Output "killed pid $($proc.ProcessId)" } catch { } }
    }
    Write-Output "config and log left in place: $StateDir"
    break
  }

  'Start' {
    if (-not (Get-Task)) { throw "not installed - run -Install first" }
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "started"; break
  }

  'Stop' {
    Assert-SafeToInterrupt -Action 'stop' -Force:$StopForce
    if (Get-Task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
    # Stop-ScheduledTask kills the task's own process tree unreliably when the
    # supervisor has spawned a grandchild, so take the processes directly too.
    $p = Get-WorkerProcess
    foreach ($proc in @($p.Supervisor, $p.Daemon)) {
      if ($proc) { try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop; Write-Output "killed pid $($proc.ProcessId)" } catch { } }
    }
    Write-Output "stopped"; break
  }

  'Restart' {
    # Checked here so the refusal names 'restart' rather than 'stop', and passed
    # through so the inner -Stop does not ask a second time.
    Assert-SafeToInterrupt -Action 'restart' -Force:$RestartForce
    & $PSCommandPath -Stop -StopForce | Out-Null
    Start-Sleep -Seconds 1
    & $PSCommandPath -Start
    break
  }

  'Log' {
    if (-not (Test-Path $LogFile)) { Write-Output "no log yet: $LogFile"; break }
    Get-Content $LogFile -Tail $Tail
    break
  }

  default { Show-Status }
}
