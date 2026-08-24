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

  [Parameter(ParameterSetName = 'Uninstall', Mandatory = $true)][switch]$Uninstall,
  [Parameter(ParameterSetName = 'Start',     Mandatory = $true)][switch]$Start,
  [Parameter(ParameterSetName = 'Stop',      Mandatory = $true)][switch]$Stop,
  [Parameter(ParameterSetName = 'Restart',   Mandatory = $true)][switch]$Restart,
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
    Connection = 'unknown'; Since = $null; RunningSessions = 0; LastLine = $null; Board = $null
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
      # Count launches minus exits over the tail: a rough but honest in-flight count.
      $launched = ($lines | Where-Object { $_ -match 'launched agent' }).Count
      $exited   = ($lines | Where-Object { $_ -match 'agent exited' }).Count
      $state.RunningSessions = [Math]::Max(0, $launched - $exited)
      $conn = $lines | Where-Object { $_ -match 'connected to|disconnected|socket error' } | Select-Object -Last 1
      if ($conn) {
        $state.Connection = if ($conn -match 'connected to') { 'connected' } else { 'disconnected' }
        if ($conn -match '^(\d{4}-\d{2}-\d{2}T[\d:]+Z)') { $state.Since = $Matches[1] }
      }
    }
  }
  [pscustomobject]$state
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
    & $PSCommandPath -Stop | Out-Null
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
