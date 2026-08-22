# ak-worker.ps1 - install / replace / remove the agentic-kanban worker daemon
#
# The worker ships as an unpublished dev tarball (the npm release stops at 0.1.9
# and has no agentic-kanban-worker bin), so new versions arrive as files over the
# ACP blob relay. This makes replacing one a single verified step.
#
#   .\ak-worker.ps1 -Tarball .\agentic-kanban-0.1.9-dev.<sha>.tgz [-Sha256 <hex>]
#   .\ak-worker.ps1 -Remove
#   .\ak-worker.ps1 -Status
#
# Never touches ~/.agentic-kanban - that holds worker-state.json (the per-worker
# bearer token from pairing) and kanban.db. Losing it means re-pairing, and a
# pairing token is single-use with a 10-minute expiry.

[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
  [Parameter(ParameterSetName = 'Install', Mandatory = $true)][string]$Tarball,
  [Parameter(ParameterSetName = 'Install')][string]$Sha256,
  [Parameter(ParameterSetName = 'Remove', Mandatory = $true)][switch]$Remove,
  [Parameter(ParameterSetName = 'Status', Mandatory = $true)][switch]$Status
)

$ErrorActionPreference = 'Stop'
$pkg = 'agentic-kanban'
$prefix = (npm prefix -g).Trim()
$manifest = Join-Path $prefix "node_modules\$pkg\package.json"

function Get-Installed {
  # The authoritative version is the installed manifest - and it is also what
  # `agentic-kanban-worker --version` now reports: resolveVersion() in
  # worker/worker-cli.ts walks up to our own package.json, falling back to
  # "unknown" rather than to a plausible number. So the two agree, and reading the
  # manifest here just avoids shelling out. (This comment used to say --version was
  # hardcoded to 0.0.1; that was true of an older build. Corrected in #756. A bare
  # 0.0.1 from --version therefore means an OLD binary is installed, which is still
  # worth checking after a tarball handover.)
  if (-not (Test-Path $manifest)) { return $null }
  Get-Content $manifest -Raw | ConvertFrom-Json
}

function Show-Status {
  $m = Get-Installed
  if ($null -eq $m) { Write-Output "not installed (prefix: $prefix)"; return }
  Write-Output "version : $($m.version)"
  Write-Output "bins    : $($m.bin.PSObject.Properties.Name -join ', ')"
  $w = Get-Command agentic-kanban-worker -ErrorAction SilentlyContinue
  Write-Output "worker  : $(if ($w) { $w.Source } else { 'MISSING from PATH' })"
  $state = Join-Path $HOME '.agentic-kanban\worker-state.json'
  Write-Output "paired  : $(if (Test-Path $state) { "yes ($state)" } else { 'no' })"
}

function Remove-Worker {
  if ($null -eq (Get-Installed)) { Write-Output "nothing to remove"; return }
  npm rm -g $pkg
  if (Test-Path $manifest) { throw "npm rm left $manifest behind" }
  $left = Get-ChildItem $prefix -Filter 'agentic-kanban*' -ErrorAction SilentlyContinue
  if ($left) { throw "shims left behind: $($left.Name -join ', ')" }
  Write-Output "removed (pairing state under ~/.agentic-kanban left intact)"
}

switch ($PSCmdlet.ParameterSetName) {
  'Status' { Show-Status; break }
  'Remove' { Remove-Worker; break }
  'Install' {
    if (-not (Test-Path $Tarball)) { throw "no such tarball: $Tarball" }
    $Tarball = (Resolve-Path $Tarball).Path

    if ($Sha256) {
      $actual = (Get-FileHash $Tarball -Algorithm SHA256).Hash.ToLower()
      if ($actual -ne $Sha256.ToLower()) {
        throw "sha256 mismatch`n  expected $($Sha256.ToLower())`n  actual   $actual"
      }
      Write-Output "sha256 ok"
    } else {
      Write-Warning "no -Sha256 given; installing an unverified tarball"
    }

    # Refuse a tarball without the worker bin - the published 0.1.9 has only two
    # bins, and installing it leaves a working CLI with no daemon.
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ak-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
      tar -xzf $Tarball -C $tmp 'package/package.json'
      $incoming = Get-Content (Join-Path $tmp 'package\package.json') -Raw | ConvertFrom-Json
      if (-not $incoming.bin.'agentic-kanban-worker') {
        throw "tarball declares no agentic-kanban-worker bin (version $($incoming.version)) - wrong artifact"
      }
      Write-Output "tarball ok: $($incoming.version)"
    } finally {
      Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    $before = Get-Installed
    if ($before) { Write-Output "replacing $($before.version)"; Remove-Worker }

    npm i -g $Tarball

    $after = Get-Installed
    if ($null -eq $after) { throw "install produced no manifest at $manifest" }
    if ($after.version -ne $incoming.version) {
      # Same-version tarballs can be served from the npm cache instead of the
      # file - the reason builds are stamped 0.1.9-dev.<sha> rather than 0.1.9.
      throw "installed $($after.version) but tarball was $($incoming.version) - npm served a cached copy; run 'npm cache clean --force' and retry"
    }
    if (-not (Get-Command agentic-kanban-worker -ErrorAction SilentlyContinue)) {
      throw "agentic-kanban-worker is not on PATH after install"
    }
    Write-Output ""
    Show-Status
  }
}
