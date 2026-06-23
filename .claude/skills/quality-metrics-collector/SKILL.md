---
name: quality-metrics-collector
description: Collect repository code-health metrics and POST them to the board Quality Metrics API
---

# quality-metrics-collector

Collect a small, defensible batch of quality metrics for the current repo and POST them to `/api/projects/<projectId>/quality-metrics`. Key decisions:

- **Server port** — prefer `KANBAN_BOARD_SERVER_PORT` (the board that owns the issue and stores metrics), then `KANBAN_SERVER_PORT` (in worktrees this points at the worktree dev server, not the board), else `3001`.
- **Project id** — read it from the issue description's `Project ID: <uuid>` line (collector issues include it). Only fall back to matching the git root against `/api/projects` for manual runs from the registered checkout — launched collector agents run in worktrees whose paths don't match the registered project path.
- **scc** — prefer the `code-metrics` skill's bundled `$HOME\.claude\skills\code-metrics\tools\scc.exe` over PATH. If neither resolves, **skip LOC metrics and report the blocker — never invent numbers** (install via `cd $HOME\.claude\skills\code-metrics; .\setup.ps1`). For richer per-module LOC you may instead run `code-metrics analyze <repo>` (if `.venv\Scripts\code-metrics.exe` exists) and read `code-metrics-out/analysis.json`, but the direct `scc` call below is sufficient.

## Metrics

Compute locally, without mutating the repo:
- `code.production_loc` (`lines`), `code.test_loc` (`lines`), `code.test_ratio` = `test_loc / (production_loc + test_loc) * 100` (`percent`), `code.source_files` (`files`), `git.changed_files` (`files`).
- Only if the user specifically asked AND a fast established command exists: `coverage.lines` (`percent`), `lint.errors` (`count`), `typecheck.errors` (`count`).

Never run destructive setup, cleanup, DB reset, or broad formatting commands.

## Reference implementation (run from repo root)

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
  # Only pass paths that exist — scc prints a non-JSON "file or directory does not exist"
  # line to stdout for a missing path, which breaks ConvertFrom-Json.
  $candidatePaths = @("packages/client/src","packages/server/src","packages/shared/src","packages/mcp-server/src","packages/e2e","packages/desktop/src")
  $paths = $candidatePaths | Where-Object { Test-Path $_ }
  # --by-file is required: scc's default JSON is one summary row per language with an empty
  # Files[] array and no "Total" row, so per-file test detection and totals are impossible.
  # Join the multi-line output before parsing.
  $raw = & $sccCmd @paths --include-ext ts,tsx,css --no-complexity --by-file --format json
  $sccJson = ($raw -join "`n") | ConvertFrom-Json
  $allFiles = $sccJson | ForEach-Object { $_.Files }
  $totFiles = $allFiles.Count
  $totCode = ($sccJson | Measure-Object -Property Code -Sum).Sum
  $testFiles = $allFiles | Where-Object { $_.Location -match '(__tests__|\.test\.|\.spec\.|packages[\\/]e2e)' }
  $testLoc = ($testFiles | Measure-Object -Property Code -Sum).Sum
  if (-not $testLoc) { $testLoc = 0 }
  $prodLoc = [Math]::Max(0, [double]$totCode - [double]$testLoc)
  $testRatio = if (($prodLoc + [double]$testLoc) -gt 0) { ([double]$testLoc / ($prodLoc + [double]$testLoc)) * 100 } else { 0 }
  $metrics += @{ metricKey = "code.production_loc"; value = [double]$prodLoc; unit = "lines"; meta = @{ source = "scc" } }
  $metrics += @{ metricKey = "code.test_loc"; value = [double]$testLoc; unit = "lines"; meta = @{ source = "scc" } }
  $metrics += @{ metricKey = "code.test_ratio"; value = [double]$testRatio; unit = "percent"; meta = @{ source = "scc" } }
  $metrics += @{ metricKey = "code.source_files"; value = [double]$totFiles; unit = "files"; meta = @{ source = "scc" } }
} else {
  Write-Warning "scc unavailable — skipping LOC metrics. Run setup.ps1 in the code-metrics skill to bundle it."
}

$changed = (git status --porcelain | Measure-Object).Count
$metrics += @{ metricKey = "git.changed_files"; value = [double]$changed; unit = "files"; meta = @{ source = "git status --porcelain" } }

$body = @{ commitSha = $commitSha; collectedAt = (Get-Date).ToUniversalTime().ToString("o"); metrics = $metrics } | ConvertTo-Json -Depth 8
Invoke-RestMethod "$baseUrl/api/projects/$projectId/quality-metrics" -Method Post -ContentType "application/json" -Body $body
```

## Report

After posting, summarize the metric keys, values, commit SHA, and endpoint response. If a metric was skipped (tool missing / command not configured), say exactly which one and why.
