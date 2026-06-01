param(
  [string]$Url = "http://127.0.0.1:5173",
  [int]$TimeoutSeconds = 20,
  [int]$SnippetLength = 500,
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

function Invoke-SelfTest {
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

$matcher = "Todo|In Progress|No issues|No projects registered"
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$found = $false

try {
  $env:npm_config_loglevel = "silent"
  & playwright-cli open $Url | Out-Host

  while ((Get-Date) -lt $deadline) {
    $renderedText = & playwright-cli eval "document.querySelector('main')?.innerText || document.querySelector('#root')?.innerText || document.body?.innerText || ''" 2>&1
    $renderedTextString = ConvertTo-SmokeText $renderedText

    if ($renderedTextString -match $matcher) {
      Write-Host (Format-SmokeSnippet $renderedText $SnippetLength)
      $found = $true
      break
    }

    Start-Sleep -Seconds 1
  }

  if (-not $found) {
    Write-Host "Timed out waiting for hydrated board content."
    Write-Host "--- console ---"
    try { & playwright-cli console | Out-Host } catch { Write-Host $_ }

    Write-Host "--- rendered text ---"
    $text = & playwright-cli eval "document.querySelector('main')?.innerText || document.querySelector('#root')?.innerText || document.body?.innerText || '<empty rendered text>'" 2>&1
    Write-Host (Format-SmokeSnippet $text 1000)

    Write-Host "--- app root html ---"
    $html = & playwright-cli eval "document.querySelector('main')?.innerHTML || document.querySelector('#root')?.innerHTML || document.body?.innerHTML || '<empty rendered html>'" 2>&1
    Write-Host (Format-SmokeSnippet $html 1500)

    exit 1
  }
} finally {
  try { & playwright-cli close | Out-Host } catch { Write-Host $_ }
}
