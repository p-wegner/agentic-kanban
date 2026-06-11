# Copilot sessions — event format + inspection

Primary path is `node scripts/analyze-copilot-session.mjs --latest` (structured
summary: model, duration, turns, tool usage, commands, assistant messages, files
modified, shutdown type). These are the manual/API fallbacks.

Copilot CLI stores full session transcripts as `events.jsonl` in `~/.copilot/session-state/<uuid>/`. Each directory also has `workspace.yaml` with metadata. Session data is also available via the board API.

## Event types in `events.jsonl`

| Type | Description |
|------|-------------|
| `session.start` | Session init: sessionId, copilotVersion, context (cwd, branch, gitRoot) |
| `session.model_change` | Model switch: newModel, reasoningEffort |
| `system.message` | System prompt (long — use `-Tail` carefully) |
| `user.message` | User prompt: content, attachments |
| `assistant.turn_start` / `assistant.turn_end` | Turn boundaries |
| `assistant.message` | Agent response: content, model, toolRequests (with toolCallId, name, arguments) |
| `tool.execution_start` / `tool.execution_complete` | Tool execution: toolCallId, toolName, arguments, result |
| `hook.start` / `hook.end` | Hook execution: hookType (preToolUse/postToolUse), success |
| `system.notification` | Background notifications (shell completed, etc.) |
| `session.shutdown` | Session end: shutdownType, totalApiDurationMs, codeChanges (linesAdded/Removed/filesModified) |

## Automated analysis

```powershell
# Analyze a specific session
node scripts/analyze-copilot-session.mjs "C:\Users\pwegner\.copilot\session-state\390de5e5-...\events.jsonl"

# List all Copilot sessions (most recent first)
node scripts/analyze-copilot-session.mjs --list

# Analyze the most recent Copilot session
node scripts/analyze-copilot-session.mjs --latest
```

The script produces a structured summary: model, duration, turns, tool usage, commands run, assistant messages, files modified, and shutdown type.

## List all Copilot sessions (local)

```powershell
Get-ChildItem "$env:USERPROFILE\.copilot\session-state" -Directory |
  Sort-Object LastWriteTime -Descending |
  ForEach-Object {
    $eventsFile = Join-Path $_.FullName "events.jsonl"
    $hasEvents = Test-Path $eventsFile
    $size = if ($hasEvents) { "$([math]::Round((Get-Item $eventsFile).Length/1KB))KB" } else { "(no events)" }
    "  $($_.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))  $size  $($_.Name)"
  }
```

## Parse Copilot session tail (manual)

```powershell
$file = "C:\Users\pwegner\.copilot\session-state\SESSION_ID\events.jsonl"
$tail = 30

$lines = Get-Content $file -Tail $tail
$agentMsgs = 0; $lastText = ""; $toolCalls = 0

foreach ($line in $lines) {
  try { $obj = $line | ConvertFrom-Json } catch { continue }
  $type = $obj.type
  if ($type -eq "assistant.message" -and $obj.data.content) {
    $lastText = $obj.data.content
    $agentMsgs++
  }
  if ($type -eq "tool.execution_start" -and $obj.data.toolName) {
    $toolCalls++
  }
}

Write-Output "Agent msgs (in tail): $agentMsgs"
Write-Output "Tool calls (in tail): $toolCalls"
Write-Output "Last agent text: $lastText"
```

## Read Copilot session output (via board API)

The board API provides a parsed summary even if local files aren't available:

```powershell
$sessionId = "SESSION_ID"
$summary = Invoke-RestMethod "http://localhost:$env:KANBAN_SERVER_PORT/api/sessions/$sessionId/summary" -TimeoutSec 10
Write-Host "Duration: $($summary.duration)"
Write-Host "Model: $($summary.model)"
Write-Host "Status: $($summary.status)"
Write-Host "Agent summary: $($summary.agentSummary.Substring(0, [math]::Min(500, $summary.agentSummary.Length)))"
```

## Correlate Copilot sessions with board workspaces

```powershell
$issueNum = "32"
$board = Invoke-RestMethod "http://localhost:$env:KANBAN_SERVER_PORT/api/projects/f6046402-8373-4294-9624-e0e4e54e1961/board" -TimeoutSec 10
$issue = $board.issues | Where-Object { $_.issueNumber -eq $issueNum }
$ws = $issue.workspaces | Select-Object -First 1
Write-Host "Workspace: $($ws.id) branch=$($ws.branch) status=$($ws.status)"

$sessions = Invoke-RestMethod "http://localhost:$env:KANBAN_SERVER_PORT/api/workspaces/$($ws.id)/sessions" -TimeoutSec 10
$sessions | ForEach-Object {
  Write-Host "  $($_.id) status=$($_.status) provider=$($_.provider) trigger=$($_.triggerType) started=$($_.startedAt)"
}
```

## Check Copilot process logs

```powershell
# Most recent log — shows model requests, compaction, MCP loading, errors
$log = Get-ChildItem "$env:USERPROFILE\.copilot\logs" -Filter "*.log" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content $log.FullName | Where-Object { $_ -match "\[ERROR\]|notification:|Skipping|Workspace initialized" }
```

## Common Copilot session issues

| Symptom | Likely cause |
|---------|-------------|
| `overview: "No activity recorded"` in board API | Copilot MCP was disabled by org policy; session ran but tools didn't fire |
| `model: ""` empty in board summary | Model extraction from Copilot events failed; check session-output.ts parsing |
| Session completes in <2min with open question | Agent asked user a question, got no response, session ended |
| `Skipping third-party MCP server` in logs | Org policy blocks MCP; agent ran without kanban tools |
| No `events.jsonl` in session dir | Session terminated too early (before first event was written) |
