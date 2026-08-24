# ak-worker-tray.ps1 - a coloured dot in the systray for the agentic-kanban
# fleet worker on this machine.
#
#   powershell -NoProfile -File ak-worker-tray.ps1        (or the .vbs, hidden)
#
# Answers one question at a glance: is this machine actually available to the
# board right now? That question has a history - the worker looked registered and
# healthy for an hour while every dispatch to it silently wedged - so the states
# are deliberately distinguishable rather than a binary up/down:
#
#   grey    service not installed / not running      nothing will be dispatched
#   red     supervisor up, daemon down (backoff)     or the log says disconnected
#   yellow  connected, but the board is unreachable  from here
#   green   connected and idle                       ready for work
#   blue    running N agent session(s)               working
#
# Conventions borrowed from fleet/tray/fleet-tray.ps1, which learned them the
# hard way: icons are created ONCE and reused (regenerating per tick is the
# classic tray GDI leak), and every timer tick is wrapped in try/catch because an
# unhandled exception inside a Forms.Timer handler tears down the message loop
# and the icon vanishes with no trace.
#
# Deliberately does NOT shell out to the service script per tick: state comes
# from the log tail plus a process check, both cheap. The board probe runs on a
# slower timer since it is the only network call.

[CmdletBinding()]
param(
  [int]$IntervalMs = 3000,
  [int]$BoardProbeEveryTicks = 10
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# One instance only; the Startup shortcut and a manual launch must not fight.
$mutex = New-Object System.Threading.Mutex($false, 'Global\AkWorkerTray')
if (-not $mutex.WaitOne(0)) { Write-Output "ak-worker tray already running"; exit 0 }

$ServiceScript = Join-Path $PSScriptRoot 'ak-worker-service.ps1'
$StateDir   = Join-Path $env:LOCALAPPDATA 'agentic-kanban-worker'
$ConfigFile = Join-Path $StateDir 'config.json'
$LogFile    = Join-Path $StateDir 'worker.log'
$TaskName   = 'AgenticKanbanWorker'

# ── icons, built once ─────────────────────────────────────────────────────────
function New-DotIcon {
  param([System.Drawing.Color]$Color)
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush $Color
  $g.FillEllipse($brush, 2, 2, 12, 12)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(90, 0, 0, 0)), 1
  $g.DrawEllipse($pen, 2, 2, 12, 12)
  $brush.Dispose(); $pen.Dispose(); $g.Dispose()
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $bmp.Dispose()
  return $icon
}
$Icons = @{
  grey   = New-DotIcon ([System.Drawing.Color]::FromArgb(150, 150, 150))
  red    = New-DotIcon ([System.Drawing.Color]::FromArgb(214,  69,  65))
  yellow = New-DotIcon ([System.Drawing.Color]::FromArgb(226, 176,  55))
  green  = New-DotIcon ([System.Drawing.Color]::FromArgb( 76, 175,  80))
  blue   = New-DotIcon ([System.Drawing.Color]::FromArgb( 52, 130, 214))
}

$script:boardOk = $null      # $null = not probed yet
$script:tick = 0
$script:lastKey = ''

function Get-State {
  $s = [ordered]@{
    installed = $false; supervisor = $false; daemon = $false
    connection = 'unknown'; since = $null; sessions = 0; board = $null; lastLine = $null
  }
  $s.installed = [bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='powershell.exe'" -ErrorAction SilentlyContinue
  $s.supervisor = [bool]($procs | Where-Object { $_.CommandLine -like '*ak-worker-run.ps1*' } | Select-Object -First 1)
  $s.daemon = [bool]($procs | Where-Object {
      $_.CommandLine -like '*agentic-kanban*' -and $_.CommandLine -like '*worker*' -and $_.CommandLine -notlike '*ak-worker-run.ps1*'
    } | Select-Object -First 1)
  if (Test-Path $ConfigFile) { try { $s.board = (Get-Content $ConfigFile -Raw | ConvertFrom-Json).board } catch { } }
  if (Test-Path $LogFile) {
    $lines = Get-Content $LogFile -Tail 400 -ErrorAction SilentlyContinue
    if ($lines) {
      $s.lastLine = $lines[-1]
      $launched = ($lines | Where-Object { $_ -match 'launched agent' }).Count
      $exited   = ($lines | Where-Object { $_ -match 'agent exited' }).Count
      $s.sessions = [Math]::Max(0, $launched - $exited)
      $conn = $lines | Where-Object { $_ -match 'connected to|disconnected|socket error' } | Select-Object -Last 1
      if ($conn) {
        $s.connection = if ($conn -match 'connected to') { 'connected' } else { 'disconnected' }
        if ($conn -match '(\d{4}-\d{2}-\d{2}T[\d:]+Z)') { $s.since = $Matches[1] }
      }
    }
  }
  [pscustomobject]$s
}

function Get-Verdict {
  param($s)
  if (-not $s.installed -and -not $s.supervisor) { return @{ key='grey';   text='not installed' } }
  if (-not $s.supervisor)                        { return @{ key='grey';   text='service stopped' } }
  if (-not $s.daemon)                            { return @{ key='red';    text='daemon down (restarting)' } }
  if ($s.connection -ne 'connected')             { return @{ key='red';    text="disconnected from board" } }
  if ($s.sessions -gt 0)                         { return @{ key='blue';   text="running $($s.sessions) session(s)" } }
  if ($script:boardOk -eq $false)                { return @{ key='yellow'; text='board unreachable from here' } }
  return @{ key='green'; text='connected, idle' }
}

# ── tray icon + menu ──────────────────────────────────────────────────────────
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $Icons.grey
$tray.Text = 'kanban worker - starting...'
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miState = $menu.Items.Add('(starting)'); $miState.Enabled = $false
$menu.Items.Add('-') | Out-Null
$miStart   = $menu.Items.Add('Start')
$miStop    = $menu.Items.Add('Stop')
$miRestart = $menu.Items.Add('Restart')
$menu.Items.Add('-') | Out-Null
$miLog     = $menu.Items.Add('Open log')
$miDash    = $menu.Items.Add('Open dashboard (live)')
$menu.Items.Add('-') | Out-Null
$miExit    = $menu.Items.Add('Exit tray (worker keeps running)')
$tray.ContextMenuStrip = $menu

# Service actions shell out on demand only - never on a timer tick.
$svc = { param($flag) Start-Process powershell.exe -ArgumentList @(
    '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$ServiceScript`"",$flag) -WindowStyle Hidden }
$miStart.Add_Click({   try { & $svc '-Start' }   catch { } })
$miStop.Add_Click({    try { & $svc '-Stop' }    catch { } })
$miRestart.Add_Click({ try { & $svc '-Restart' } catch { } })
$miLog.Add_Click({ try { if (Test-Path $LogFile) { Start-Process notepad.exe $LogFile } } catch { } })
# Was 'Status in a window', which ran the service script's -Status once in a
# PowerShell window: correct at the instant you opened it and stale thereafter.
# Every interesting worker state is a TRANSITION - reconnect backoff, a dispatch
# arriving, an agent exiting - so a frozen snapshot answered the wrong question.
# The dashboard streams the same state over SSE instead. Launched via the .vbs so
# node never flashes a console.
$miDash.Add_Click({
  try {
    $vbs = Join-Path $PSScriptRoot 'ak-worker-dashboard-launch.vbs'
    if (Test-Path $vbs) { Start-Process wscript.exe -ArgumentList "`"$vbs`"" }
  } catch { }
})
$miExit.Add_Click({
  $tray.Visible = $false
  foreach ($i in $Icons.Values) { $i.Dispose() }
  [System.Windows.Forms.Application]::Exit()
})
# Double-click is the fast path to the log, which is where every answer has been.
$tray.Add_DoubleClick({ try { if (Test-Path $LogFile) { Start-Process notepad.exe $LogFile } } catch { } })

# ── the tick ──────────────────────────────────────────────────────────────────
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $IntervalMs
$timer.Add_Tick({
  # Wrapped whole: an exception here would kill the message loop and the icon.
  try {
    $script:tick++
    $s = Get-State

    if ($s.board -and ($script:tick % $BoardProbeEveryTicks -eq 1)) {
      try {
        $r = Invoke-WebRequest -Uri "$($s.board)/api/health" -TimeoutSec 4 -UseBasicParsing
        $script:boardOk = ($r.StatusCode -eq 200)
      } catch { $script:boardOk = $false }
    }

    $v = Get-Verdict $s
    if ($v.key -ne $script:lastKey) { $tray.Icon = $Icons[$v.key]; $script:lastKey = $v.key }

    $reach = switch ($script:boardOk) { $true { 'board ok' } $false { 'board unreachable' } default { 'board not probed' } }
    # NotifyIcon.Text throws above 63 chars on some paths - keep it short.
    $t = "kanban worker: $($v.text)"
    if ($t.Length -gt 63) { $t = $t.Substring(0, 60) + '...' }
    $tray.Text = $t
    $miState.Text = "$($v.text) - $reach$(if ($s.since) { " - since $($s.since)" })"
  } catch { }
})
$timer.Start()

$ctx = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($ctx)
$tray.Visible = $false
$tray.Dispose()
$mutex.ReleaseMutex()
