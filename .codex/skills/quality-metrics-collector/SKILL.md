---
name: quality-metrics-collector
description: Gather repository quality metrics such as productive code lines, test ratio, and available test or lint counts, then post them to the agentic-kanban quality metrics endpoint. Use when asked to collect, refresh, record, or publish quality metrics for the current project.
---

# quality-metrics-collector

Collect a small, defensible batch of quality metrics for the current repository and post it to the board API.

## Endpoint

Use the main board API port when available. In agent worktrees, `KANBAN_SERVER_PORT`
usually points at the worktree dev server; `KANBAN_BOARD_SERVER_PORT` is the board
that owns the issue and stores metrics.

```powershell
$serverPort = if ($env:KANBAN_BOARD_SERVER_PORT) { $env:KANBAN_BOARD_SERVER_PORT } elseif ($env:KANBAN_SERVER_PORT) { $env:KANBAN_SERVER_PORT } else { "3001" }
$baseUrl = "http://127.0.0.1:$serverPort"
```

Resolve the project id from the issue description first. The Quality Metrics view
creates collector issues with a `Project ID: <uuid>` line; use that exact id. Only
fall back to matching the current git root to `/api/projects` for manual runs from
the registered checkout, because launched collector agents run inside worktrees
whose paths do not match the registered project path.

```powershell
$projectId = "<Project ID from the issue description>"
if (-not $projectId -or $projectId -like "<*") {
  $repoRoot = (git rev-parse --show-toplevel).Trim()
  $projects = Invoke-RestMethod "$baseUrl/api/projects"
  $project = $projects | Where-Object { [IO.Path]::GetFullPath($_.repoPath).TrimEnd('\') -eq [IO.Path]::GetFullPath($repoRoot).TrimEnd('\') } | Select-Object -First 1
  if (-not $project) { throw "No registered project matches $repoRoot" }
  $projectId = $project.id
}
```

Post to:

```powershell
POST $baseUrl/api/projects/$projectId/quality-metrics
```

## Metrics

Prefer metrics that can be computed locally without mutating the repo:

- `code.production_loc`: productive source lines, unit `lines`
- `code.test_loc`: productive test lines, unit `lines`
- `code.test_ratio`: `test_loc / (production_loc + test_loc) * 100`, unit `percent`
- `code.source_files`: counted source files, unit `files`
- `git.changed_files`: currently changed tracked/untracked files, unit `files`

If the repo has a fast, established command for coverage, lint, or typecheck and the user asked for those specifically, run it and add:

- `coverage.lines`: line coverage percentage, unit `percent`
- `lint.errors`: lint error count, unit `count`
- `typecheck.errors`: typecheck error count, unit `count`

Do not run destructive setup, cleanup, database reset, or broad formatting commands.

## scc resolution — prefer the code-metrics skill's bundled binary

Rather than relying on `scc` being on PATH, prefer the bundled `scc.exe` that ships
with the `code-metrics` skill (installed at `C:\Users\pwegner\.claude\skills\code-metrics`
on this system, or equivalently `$HOME\.claude\skills\code-metrics`). Resolve in order:

```powershell
$sccCmd = $null
$codeMetricsSkillRoot = "$HOME\.claude\skills\code-metrics"
$bundledScc = Join-Path $codeMetricsSkillRoot "tools\scc.exe"
if (Test-Path $bundledScc) {
  $sccCmd = $bundledScc
} elseif (Get-Command scc -ErrorAction SilentlyContinue) {
  $sccCmd = "scc"
}
if (-not $sccCmd) {
  Write-Warning "scc not found — LOC metrics will be skipped. Install via code-metrics skill: cd $codeMetricsSkillRoot; .\setup.ps1"
}
```

If the `code-metrics` CLI itself is available (`$codeMetricsSkillRoot\.venv\Scripts\code-metrics.exe`),
you may instead run `code-metrics analyze <repo>` and read `code-metrics-out/analysis.json`
for richer per-module LOC data — but the direct `scc` call below is sufficient for
standard quality-metrics collection.

## Reference Implementation

This PowerShell sketch is acceptable to run from the repo root. If `scc` is unavailable, report that blocker and skip LOC metrics instead of inventing numbers.

```powershell
$serverPort = if ($env:KANBAN_BOARD_SERVER_PORT) { $env:KANBAN_BOARD_SERVER_PORT } elseif ($env:KANBAN_SERVER_PORT) { $env:KANBAN_SERVER_PORT } else { "3001" }
$baseUrl = "http://127.0.0.1:$serverPort"
$projectId = "<Project ID from the issue description>"
$repoRoot = (git rev-parse --show-toplevel).Trim()
$commitSha = (git rev-parse HEAD).Trim()
if (-not $projectId -or $projectId -like "<*") {
  $projects = Invoke-RestMethod "$baseUrl/api/projects"
  $project = $projects | Where-Object { [IO.Path]::GetFullPath($_.repoPath).TrimEnd('\') -eq [IO.Path]::GetFullPath($repoRoot).TrimEnd('\') } | Select-Object -First 1
  if (-not $project) { throw "No registered project matches $repoRoot" }
  $projectId = $project.id
}

# Resolve scc — prefer code-metrics skill's bundled binary over PATH
$sccCmd = $null
$bundledScc = "$HOME\.claude\skills\code-metrics\tools\scc.exe"
if (Test-Path $bundledScc) { $sccCmd = $bundledScc }
elseif (Get-Command scc -ErrorAction SilentlyContinue) { $sccCmd = "scc" }

$metrics = @()

if ($sccCmd) {
  $sccJson = & $sccCmd packages/client/src packages/server/src packages/shared/src packages/mcp-server/src packages/e2e packages/desktop/src --include-ext ts,tsx,css --no-complexity --format json | ConvertFrom-Json
  $total = $sccJson | Where-Object { $_.Name -eq "Total" } | Select-Object -First 1
  $testRows = $sccJson | Where-Object { $_.Name -ne "Total" -and ($_.Location -match '(__tests__|\.test\.|\.spec\.|packages/e2e)') }
  $testLoc = ($testRows | Measure-Object -Property Code -Sum).Sum
  $allLoc = [double]$total.Code
  $prodLoc = [Math]::Max(0, $allLoc - [double]$testLoc)
  $testRatio = if (($prodLoc + [double]$testLoc) -gt 0) { ([double]$testLoc / ($prodLoc + [double]$testLoc)) * 100 } else { 0 }

  $metrics += @{ metricKey = "code.production_loc"; value = $prodLoc; unit = "lines"; meta = @{ source = "scc" } }
  $metrics += @{ metricKey = "code.test_loc"; value = [double]$testLoc; unit = "lines"; meta = @{ source = "scc" } }
  $metrics += @{ metricKey = "code.test_ratio"; value = $testRatio; unit = "percent"; meta = @{ source = "scc" } }
  $metrics += @{ metricKey = "code.source_files"; value = [double]$total.Files; unit = "files"; meta = @{ source = "scc" } }
} else {
  Write-Warning "scc unavailable — skipping LOC metrics. Run setup.ps1 in the code-metrics skill to bundle it."
}

$changed = (git status --porcelain | Measure-Object).Count
$metrics += @{ metricKey = "git.changed_files"; value = [double]$changed; unit = "files"; meta = @{ source = "git status --porcelain" } }

$body = @{
  commitSha = $commitSha
  collectedAt = (Get-Date).ToUniversalTime().ToString("o")
  metrics = $metrics
} | ConvertTo-Json -Depth 8

Invoke-RestMethod "$baseUrl/api/projects/$projectId/quality-metrics" -Method Post -ContentType "application/json" -Body $body
```

## Report

After posting, summarize the metric keys, values, commit SHA, and endpoint response. If a metric was skipped because a tool is missing or a command is not configured, say exactly which metric was skipped and why.
