param(
  [string]$Url = "http://127.0.0.1:5173",
  [int]$TimeoutSeconds = 20,
  [int]$SnippetLength = 500,
  [int]$PruneRetentionMinutes = 30,
  [switch]$SelfTest
)

$ErrorActionPreference = "Stop"

function ConvertTo-SmokeText {
  param(
    [AllowNull()]
    [object]$Value
  )

  if ($null -eq $Value) {
    return ""
  }

  if ($Value -is [System.Array]) {
    return (($Value | ForEach-Object {
      if ($null -eq $_) { "" } else { [string]$_ }
    }) -join [Environment]::NewLine)
  }

  return [string]$Value
}

function Format-SmokeSnippet {
  param(
    [AllowNull()]
    [object]$Value,
    [int]$MaxLength = 500
  )

  $text = ConvertTo-SmokeText $Value
  if ($MaxLength -lt 0) {
    $MaxLength = 0
  }

  $length = [Math]::Min($MaxLength, $text.Length)
  return $text.Substring(0, $length)
}

function Assert-SelfTest {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Format-SmokeUrlPort {
  param(
    [string]$Value,
    [int]$Fallback = 5173
  )

  try {
    return ([uri]$Value).Port
  } catch {
    return $Fallback
  }
}

function Show-MissingClientBindingHelp {
  param(
    [string]$Url
  )

  $port = Format-SmokeUrlPort -Value $Url
  Write-Host "Frontend smoke check could not reach the Vite client on $Url."
  Write-Host "This usually means the client is not currently bound to port $port."
  Write-Host "Suggested recovery:"
  Write-Host "  1) Restart the client process:"
  Write-Host "     pnpm --filter @agentic-kanban/client dev"
  Write-Host "  2) Verify tsx/vite tooling is on PATH:"
  Write-Host "     Get-Command tsx"
  Write-Host "     Get-Command vite"
  Write-Host "  3) If either command fails, repair bin shims:"
  Write-Host "     node scripts/bin-shims-preflight.mjs"
}

function Remove-StalePlaywrightArtifacts {
  param(
    [string]$ArtifactDir,
    [int]$RetentionMinutes = 30
  )

  if (-not (Test-Path $ArtifactDir)) {
    return
  }

  $cutoff = (Get-Date).AddMinutes(-$RetentionMinutes)
  $removed = 0

  Get-ChildItem -Path $ArtifactDir -File -Recurse |
    Where-Object { $_.LastWriteTimeUtc -lt $cutoff.ToUniversalTime() } |
    ForEach-Object {
      try {
        Remove-Item $_.FullName -Force -ErrorAction Stop
        $removed++
      } catch {
        Write-Host "prune: could not remove $($_.FullName): $_"
      }
    }

  # Remove empty subdirectories left behind (bottom-up so nested dirs clear)
  Get-ChildItem -Path $ArtifactDir -Directory -Recurse |
    Sort-Object { $_.FullName.Length } -Descending |
    Where-Object { @(Get-ChildItem $_.FullName -Force).Count -eq 0 } |
    ForEach-Object {
      try { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue } catch {}
    }

  if ($removed -gt 0) {
    Write-Host "prune: removed $removed stale artifact(s) older than $RetentionMinutes min"
  }
}

function Invoke-SelfTest {
  # --- Prune logic tests ---
  $testDir = Join-Path $env:TEMP "pw-smoke-prune-test-$(Get-Random)"
  try {
    New-Item -ItemType Directory -Path $testDir -Force | Out-Null

    # Create stale file (old enough to prune)
    $stale = Join-Path $testDir "stale.yml"
    Set-Content -Path $stale -Value "old" -Force
    $staleItem = Get-Item $stale
    $staleItem.LastWriteTimeUtc = (Get-Date).AddMinutes(-60).ToUniversalTime()

    # Create recent file (within retention window)
    $recent = Join-Path $testDir "recent.yml"
    Set-Content -Path $recent -Value "fresh" -Force

    # Prune with 30-min retention
    Remove-StalePlaywrightArtifacts -ArtifactDir $testDir -RetentionMinutes 30

    Assert-SelfTest (-not (Test-Path $stale)) "Stale file should have been removed."
    Assert-SelfTest (Test-Path $recent) "Recent file should have been kept."

    # --- Empty-dir cleanup ---
    $nested = Join-Path $testDir "sub"
    New-Item -ItemType Directory -Path $nested -Force | Out-Null
    Remove-StalePlaywrightArtifacts -ArtifactDir $testDir -RetentionMinutes 30
    Assert-SelfTest (-not (Test-Path $nested)) "Empty subdir should have been removed."
  } finally {
    Remove-Item $testDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  # --- Snippet formatter tests ---
  $shapes = @(
    $null,
    "",
    "Todo",
    (, @("Todo", "In Progress", "No issues", "x", "y", "z")),
    (, @("", "No projects registered", $null, "Done")),
    (, @(1, @{ status = "Todo" }, [pscustomobject]@{ text = "In Progress" }))
  )

  foreach ($shape in $shapes) {
    $snippet = Format-SmokeSnippet -Value $shape -MaxLength 12
    Assert-SelfTest ($snippet.Length -le 12) "Snippet exceeded requested bound."
  }

  $hydrated = @("Todo", "In Progress", "No issues", "x", "y", "z")
  $oldPatternThrew = $false
  try {
    $hydrated.Substring(0, [Math]::Min(500, $hydrated.Length)) | Out-Null
  } catch {
    $oldPatternThrew = $true
  }

  Assert-SelfTest $oldPatternThrew "Old array Substring pattern did not reproduce the smoke-check failure."

  $snippet = Format-SmokeSnippet -Value $hydrated -MaxLength 500
  Assert-SelfTest ($snippet -match "Todo") "Hydrated array output lost expected text."
  Assert-SelfTest ($snippet -match "In Progress") "Hydrated array output lost expected multiline text."

  Write-Host "frontend-smoke self-test OK"
}

if ($SelfTest) {
  Invoke-SelfTest
  exit 0
}

# Prune stale .playwright-cli artifacts to avoid ENOSPC from unbounded accumulation.
$artifactDirRaw = Join-Path (Join-Path $PSScriptRoot "..") ".playwright-cli"
$artifactDir = $null
try { $artifactDir = (Resolve-Path $artifactDirRaw -ErrorAction Stop).Path } catch {}
if ($artifactDir) {
  Remove-StalePlaywrightArtifacts -ArtifactDir $artifactDir -RetentionMinutes $PruneRetentionMinutes
}

$matcher = "Todo|In Progress|No issues|No projects registered"
# Pattern for "Vite up but React not yet hydrated" -- matches empty/whitespace/loading
$emptyRenderMatcher = "^[\s]*$|^loading[…\.]*$"
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$found = $false
$emptyRenderStreak = 0
# After this many consecutive empty-render probes, emit a diagnostic and keep waiting
$emptyRenderWarnAfter = 5

# Store JS expressions in variables so the || operators are never inline-parsed by PS 5.1.
$jsInnerText = "document.querySelector('main')?.innerText || document.querySelector('#root')?.innerText || document.body?.innerText || ''"
$jsInnerTextFallback = "document.querySelector('main')?.innerText || document.querySelector('#root')?.innerText || document.body?.innerText || '<empty rendered text>'"
$jsInnerHtml = "document.querySelector('main')?.innerHTML || document.querySelector('#root')?.innerHTML || document.body?.innerHTML || '<empty rendered html>'"

try {
  $env:npm_config_loglevel = "silent"
  try {
    & playwright-cli open $Url | Out-Host
  } catch {
    $openError = ConvertTo-SmokeText $_
    Write-Host "Unable to reach $Url."
    if ($openError -match "ECONNREFUSED|connection refused|Could not connect|ERR_CONNECTION_REFUSED|No connection could be made") {
      Show-MissingClientBindingHelp -Url $Url
    } else {
      Write-Host $openError
    }
    exit 1
  }

  while ((Get-Date) -lt $deadline) {
    $renderedText = $null
    try {
      $renderedText = & playwright-cli eval $jsInnerText
    } catch {
      $renderedText = ""
    }
    $renderedTextString = ConvertTo-SmokeText $renderedText

    if ($renderedTextString -match $matcher) {
      Write-Host (Format-SmokeSnippet $renderedText $SnippetLength)
      $found = $true
      break
    }

    # Detect "Vite compiled OK but React not hydrated" separately from wrong content
    if ($renderedTextString -imatch $emptyRenderMatcher) {
      $emptyRenderStreak++
      if ($emptyRenderStreak -eq $emptyRenderWarnAfter) {
        Write-Host "smoke: Vite is serving the page but React has not hydrated after $emptyRenderStreak probes -- still waiting."
        Write-Host "--- app root html (hydration fallback snapshot) ---"
        $html = $null
        try {
          $html = & playwright-cli eval $jsInnerHtml
        } catch {
          $html = ""
        }
        Write-Host (Format-SmokeSnippet $html 1500)
        Write-Host "--- console (hydration fallback snapshot) ---"
        try { & playwright-cli console | Out-Host } catch { Write-Host $_ }
      }
    } else {
      $emptyRenderStreak = 0
    }

    Start-Sleep -Seconds 1
  }

  if (-not $found) {
    if ($emptyRenderStreak -gt 0) {
      Write-Host "Timed out: Vite compiled and served the page but React never hydrated (render was persistently empty)."
      Write-Host "Possible causes: JS bundle failed to execute, React threw during mount, or a lazy chunk failed to load."
    } else {
      Write-Host "Timed out waiting for hydrated board content."
    }
    Write-Host "--- console ---"
    try { & playwright-cli console | Out-Host } catch { Write-Host $_ }

    Write-Host "--- rendered text ---"
    $text = $null
    try {
      $text = & playwright-cli eval $jsInnerTextFallback
    } catch {
      $text = ""
    }
    Write-Host (Format-SmokeSnippet $text 1000)

    Write-Host "--- app root html ---"
    $html = $null
    try {
      $html = & playwright-cli eval $jsInnerHtml
    } catch {
      $html = ""
    }
    Write-Host (Format-SmokeSnippet $html 1500)

    exit 1
  }
} finally {
  try { & playwright-cli close | Out-Host } catch { Write-Host $_ }
}
