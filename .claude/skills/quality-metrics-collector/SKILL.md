---
name: quality-metrics-collector
description: Collect repository code-health metrics and POST them to the board Quality Metrics API
---

You are collecting quality metrics for the current repository. Do not implement product code changes.

## Goal
Collect whatever metrics are available, tolerate partial failures, and POST one batch to:
`POST /api/projects/:projectId/quality-metrics`

The issue description should include the target project id. Resolve the board API base URL from environment in this order:
1. `KANBAN_BOARD_SERVER_PORT`
2. `KANBAN_SERVER_PORT`
3. `SERVER_PORT`
4. default `3001`

Use `http://127.0.0.1:<port>/api`. Never use localhost.

## scc resolution
Prefer the `code-metrics` skill's bundled binary over PATH: resolve `$HOME\.claude\skills\code-metrics\tools\scc.exe` first (bundled by its setup.ps1), then `scc` on PATH. If neither resolves, skip LOC metrics and report the blocker — never fabricate numbers.

## Metrics
Use stable metric keys:
- `loc.total` and `loc.package.<name>` from `scc` when available. Include language/package details in `meta`.
- `coverage.lines`, `coverage.branches`, `coverage.functions` from Vitest coverage when available.
- `lint.errors` and `lint.warnings` from `eslint . --format json` when available.
- `typecheck.errors` from `tsc -b --noEmit`; count `error TS` occurrences.

## Procedure
1. Detect package manager and workspace layout from lockfiles and package metadata.
2. Capture `commitSha` with `git rev-parse HEAD`.
3. Resolve `scc` using the code-metrics skill's bundled binary first (see above).
4. Run each collector independently. If a tool is missing or a command fails, keep the metrics that did succeed and record the failure in your final response.
5. POST:
```json
{
  "commitSha": "<git sha or null>",
  "metrics": [
    { "metricKey": "loc.total", "value": 1234, "unit": "lines", "meta": { "source": "scc" } }
  ]
}
```
6. Do not fabricate unavailable metrics. If no metrics can be collected, explain what blocked collection instead of posting an empty batch.

## Useful commands
- Resolve scc: `$bundledScc = "$HOME\.claude\skills\code-metrics\tools\scc.exe"; $sccCmd = if (Test-Path $bundledScc) { $bundledScc } elseif (Get-Command scc -ErrorAction SilentlyContinue) { "scc" } else { $null }`
- `& $sccCmd --format json .`
- `pnpm exec vitest run --coverage`
- `pnpm exec eslint . --format json`
- `pnpm exec tsc -b --noEmit`
- `Invoke-RestMethod -Method Post -ContentType "application/json" -Uri "$api/projects/$projectId/quality-metrics" -Body ($body | ConvertTo-Json -Depth 10)`