---
name: session-inspector
description: Inspect agent session transcripts from Claude (~/.claude/projects/), Codex (~/.codex/sessions/), or Copilot (board API + ~/.copilot/) to debug why sessions stopped, what they did, and whether they produced output.
argument-hint: [issue-number, keyword, --codex <path>, --copilot]
---

# Session Inspector — Debugging Agent Session Transcripts

Inspect session transcripts across all three supported agents. Each stores data differently:

| Agent | Location | Format |
|-------|----------|--------|
| Claude Code | `~/.claude/projects/` | Full JSONL transcripts per session |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/` | Full JSONL transcripts per session |
| Copilot CLI | `~/.copilot/session-state/<uuid>/events.jsonl` + board DB | Full JSONL transcripts locally; also available via API |

## Directory naming convention

Each working directory maps to a session dir by replacing path separators with `--`:
- `C:\andrena\.worktrees\feature_ak-17-...` → `C--andrena--worktrees-feature-ak-17-...`
- `C:\andrena\agentic-kanban\packages\.worktrees\feature_ak-N-...` → `C--andrena-agentic-kanban-packages--worktrees-feature-ak-N-...`

Multiple `.jsonl` files in one dir = multiple sessions (e.g. original run + re-launched review). Sort by `LastWriteTime` descending to find the latest.

## Quick overview of all issues

```powershell
# List all agentic-kanban worktree session dirs with file counts and sizes
Get-ChildItem "$env:USERPROFILE\.claude\projects" -Directory |
  Where-Object { $_.Name -like "*--worktrees-feature-ak-*" } |
  Sort-Object Name |
  ForEach-Object {
    $files = Get-ChildItem $_.FullName -Filter "*.jsonl" | Sort-Object LastWriteTime -Descending
    $issueNum = if ($_.Name -match "ak-(\d+)-") { $matches[1] } else { "?" }
    $latest = $files | Select-Object -First 1
    $size = if ($latest) { "$([math]::Round($latest.Length/1KB))KB" } else { "-" }
    $age = if ($latest) { [math]::Round(((Get-Date) - $latest.LastWriteTime).TotalMinutes) } else { "-" }
    "  #$issueNum  $($files.Count) sessions  latest: $size  ${age}m ago  $($_.Name.Substring(0,[math]::Min(60,$_.Name.Length)))"
  }
```

## Inspect a specific issue's latest session

Replace `17` with the issue number:

```powershell
$issueNum = "17"
$dir = Get-ChildItem "$env:USERPROFILE\.claude\projects" -Directory |
  Where-Object { $_.Name -match "--worktrees-feature-ak-$issueNum-" } |
  Select-Object -First 1

$file = Get-ChildItem $dir.FullName -Filter "*.jsonl" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1

Write-Output "File: $($file.Name)  Size: $([math]::Round($file.Length/1KB))KB  Modified: $($file.LastWriteTime)"
Write-Output "Lines: $((Get-Content $file.FullName).Count)"
```

## Parse session tail — see what the agent did and why it stopped

This reads only the last N lines to avoid loading large files:

```powershell
$file = "C:\Users\pwegner\.claude\projects\C--andrena--worktrees-feature-ak-17-add-an-alternativ-graph-based-view-of-ti\dc54e6e0-f6b1-4a89-a1fa-478c88150f34.jsonl"
$tail = 40  # adjust as needed

$lines = Get-Content $file -Tail $tail
$turns = 0; $lastText = ""; $lastTool = ""; $stopReason = ""

foreach ($line in $lines) {
  try { $obj = $line | ConvertFrom-Json } catch { continue }
  if ($obj.type -ne "assistant") { continue }
  $stopReason = $obj.message.stop_reason
  foreach ($block in $obj.message.content) {
    if ($block.type -eq "text" -and $block.text) {
      $lastText = ($block.text -replace '\s+',' ').Substring(0, [math]::Min(300, $block.text.Length))
      $turns++
    }
    if ($block.type -eq "tool_use") {
      $lastTool = "$($block.name)  $(($block.input | ConvertTo-Json -Compress).Substring(0, [math]::Min(100, ($block.input | ConvertTo-Json -Compress).Length)))"
    }
  }
}

Write-Output "Turns (in tail): $turns"
Write-Output "stop_reason: $stopReason"
Write-Output "Last tool: $lastTool"
Write-Output "Last text: $lastText"
```

## Detect "started but never responded" sessions

These are sessions where the prompt was delivered but Claude produced zero assistant turns. Common causes: auth failure, process killed before responding, stdin closed before model replied.

```powershell
$dir = "C:\Users\pwegner\.claude\projects\C--andrena--worktrees-feature-ak-17-add-an-alternativ-graph-based-view-of-ti"

Get-ChildItem $dir -Filter "*.jsonl" | Sort-Object LastWriteTime -Descending | ForEach-Object {
  $lines = Get-Content $_.FullName
  $hasPrompt = $lines | Where-Object { ($_ | ConvertFrom-Json -ErrorAction SilentlyContinue).type -eq "user" }
  $hasReply  = $lines | Where-Object { ($_ | ConvertFrom-Json -ErrorAction SilentlyContinue).type -eq "assistant" }
  $status = if ($hasReply) { "✓ responded" } elseif ($hasPrompt) { "✗ no response (prompt received, agent silent)" } else { "✗ no prompt delivered" }
  "$($_.Name.Substring(0,8))…  $([math]::Round($_.Length/1KB))KB  $status"
}
```

## Read the last assistant message in full

```powershell
$file = "PATH\TO\session.jsonl"

$lines = Get-Content $file -Tail 80
$lastAssistant = $null
foreach ($line in $lines) {
  $obj = $line | ConvertFrom-Json -ErrorAction SilentlyContinue
  if ($obj -and $obj.type -eq "assistant") { $lastAssistant = $obj }
}

$lastAssistant.message.content |
  Where-Object { $_.type -eq "text" } |
  Select-Object -First 1 -ExpandProperty text
```

## Read what prompt was sent to the agent

```powershell
$file = "PATH\TO\session.jsonl"

Get-Content $file | ForEach-Object {
  $obj = $_ | ConvertFrom-Json -ErrorAction SilentlyContinue
  if ($obj -and $obj.type -eq "user") {
    $text = $obj.message.content
    if ($text -is [string]) { $text.Substring(0, [math]::Min(500, $text.Length)) }
    elseif ($text -is [array]) {
      ($text | Where-Object { $_.type -eq "text" } | Select-Object -First 1).text |
        ForEach-Object { $_.Substring(0, [math]::Min(500, $_.Length)) }
    }
    break  # first user message only
  }
}
```

## Find sessions by stop_reason pattern

```powershell
# Find all sessions that stopped mid-tool-use (agent was interrupted during a tool call)
Get-ChildItem "$env:USERPROFILE\.claude\projects" -Recurse -Filter "*.jsonl" |
  Where-Object { $_.DirectoryName -like "*worktrees*" } |
  ForEach-Object {
    $last = Get-Content $_.FullName -Tail 5
    foreach ($line in $last) {
      $obj = $line | ConvertFrom-Json -ErrorAction SilentlyContinue
      if ($obj -and $obj.message.stop_reason -eq "tool_use") {
        "$($_.DirectoryName | Split-Path -Leaf)  $($_.Name.Substring(0,8))…  stopped mid tool_use"
        break
      }
    }
  }
```

## Common stop_reason values and what they mean

| stop_reason | Meaning |
|-------------|---------|
| `end_turn` | Agent finished normally — said what it wanted to say |
| `tool_use` | Agent was mid-execution of a tool call when session ended (interrupted or still running) |
| `stop_sequence` | A stop sequence triggered — often auth failure ("Invalid API key") or rate limit |
| `max_tokens` | Hit context/output token limit |
| *(absent)* | Session file has user prompt but no assistant entry — agent never responded |

## Codex Sessions — Automated Analysis

Use the built-in analysis script for Codex session files:

```powershell
# Analyze a specific session
node scripts/analyze-codex-session.mjs "C:\Users\pwegner\.codex\sessions\2026\05\24\rollout-*.jsonl"

# List all Codex sessions (most recent first)
node scripts/analyze-codex-session.mjs --list

# Analyze the most recent Codex session
node scripts/analyze-codex-session.mjs --latest
```

The script produces a structured summary: model, duration, turns, tool usage, commands run, patches applied, web searches, and the last 5 agent messages.

## Codex Sessions — Manual Inspection

Codex session files are at `~/.codex/sessions/YYYY/MM/DD/`. Each file is a JSONL where every line is `{ timestamp, type, payload }`.

### Event types

| Type | Description |
|------|-------------|
| `session_meta` | Session initialization: id, cwd, model_provider, cli_version, base_instructions |
| `event_msg` | Lifecycle events: `user_message`, `agent_message`, `task_started`, `task_complete`, `token_count`, `patch_apply_end`, `web_search_end`, `context_compacted`, `thread_rolled_back`, `thread_goal_updated` |
| `response_item` | Model response items with subtypes: `message` (assistant text), `reasoning` (encrypted), `function_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output`, `tool_search_call`, `web_search_call` |
| `turn_context` | Turn metadata: model, cwd, approval_policy, sandbox_policy |
| `compacted` | Context window compaction event |

### List recent Codex sessions

```powershell
Get-ChildItem "$env:USERPROFILE\.codex\sessions" -Recurse -Filter "*.jsonl" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 10 |
  ForEach-Object {
    $size = "$([math]::Round($_.Length/1KB))KB"
    "  $($_.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))  $size  $($_.Name.Substring(0,[math]::Min(60,$_.Name.Length)))"
  }
```

### Parse Codex session tail

```powershell
$file = "PATH\TO\codex-session.jsonl"
$tail = 60

$lines = Get-Content $file -Tail $tail
$agentMsgs = 0; $lastText = ""; $toolCalls = 0; $lastTool = ""

foreach ($line in $lines) {
  try { $obj = $line | ConvertFrom-Json } catch { continue }
  if ($obj.type -eq "event_msg" -and $obj.payload.type -eq "agent_message") {
    $lastText = $obj.payload.message
    $agentMsgs++
  }
  if ($obj.type -eq "response_item" -and $obj.payload.type -eq "function_call") {
    $toolCalls++
    $lastTool = "$($obj.payload.name) $($obj.payload.arguments)".Substring(0, [math]::Min(100, "$($obj.payload.name) $($obj.payload.arguments)".Length))
  }
}

Write-Output "Agent msgs (in tail): $agentMsgs"
Write-Output "Tool calls (in tail): $toolCalls"
Write-Output "Last tool: $lastTool"
Write-Output "Last text: $lastText"
```

### Find user messages in a Codex session

```powershell
$file = "PATH\TO\codex-session.jsonl"
Get-Content $file | ForEach-Object {
  $obj = $_ | ConvertFrom-Json -ErrorAction SilentlyContinue
  if ($obj.type -eq "event_msg" -and $obj.payload.type -eq "user_message") {
    $text = $obj.payload.message
    Write-Output "USER: $($text.Substring(0, [math]::Min(200, $text.Length)))"
  }
}
```

## Copilot Sessions — Overview

Copilot CLI stores full session transcripts as `events.jsonl` in `~/.copilot/session-state/<uuid>/`. Each directory also has `workspace.yaml` with metadata. Session data is also available via the board API.

### Event types in `events.jsonl`

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

### Automated analysis

```powershell
# Analyze a specific session
node scripts/analyze-copilot-session.mjs "C:\Users\pwegner\.copilot\session-state\390de5e5-...\events.jsonl"

# List all Copilot sessions (most recent first)
node scripts/analyze-copilot-session.mjs --list

# Analyze the most recent Copilot session
node scripts/analyze-copilot-session.mjs --latest
```

The script produces a structured summary: model, duration, turns, tool usage, commands run, assistant messages, files modified, and shutdown type.

### List all Copilot sessions (local)

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

### Parse Copilot session tail (manual)

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

### Read Copilot session output (via board API)

The board API provides a parsed summary even if local files aren't available:

```powershell
$sessionId = "SESSION_ID"
$summary = Invoke-RestMethod "http://localhost:$env:KANBAN_SERVER_PORT/api/sessions/$sessionId/summary" -TimeoutSec 10
Write-Host "Duration: $($summary.duration)"
Write-Host "Model: $($summary.model)"
Write-Host "Status: $($summary.status)"
Write-Host "Agent summary: $($summary.agentSummary.Substring(0, [math]::Min(500, $summary.agentSummary.Length)))"
```

### Correlate Copilot sessions with board workspaces

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

### Check Copilot process logs

```powershell
# Most recent log — shows model requests, compaction, MCP loading, errors
$log = Get-ChildItem "$env:USERPROFILE\.copilot\logs" -Filter "*.log" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content $log.FullName | Where-Object { $_ -match "\[ERROR\]|notification:|Skipping|Workspace initialized" }
```

### Common Copilot session issues

| Symptom | Likely cause |
|---------|-------------|
| `overview: "No activity recorded"` in board API | Copilot MCP was disabled by org policy; session ran but tools didn't fire |
| `model: ""` empty in board summary | Model extraction from Copilot events failed; check session-output.ts parsing |
| Session completes in <2min with open question | Agent asked user a question, got no response, session ended |
| `Skipping third-party MCP server` in logs | Org policy blocks MCP; agent ran without kanban tools |
| No `events.jsonl` in session dir | Session terminated too early (before first event was written) |

## Tips

- **Never `Get-Content` a large JSONL without `-Tail`** — some files are 1-2MB+ and will flood the terminal.
- Each line is a self-contained JSON object; parse line-by-line with `ConvertFrom-Json -ErrorAction SilentlyContinue`.
- For **Claude sessions**: the `sessionId` field is on most entries and matches the filename (minus `.jsonl`). `ai-title`, `queue-operation`, `attachment` entries are metadata — only `user` and `assistant` entries carry content.
- For **Codex sessions**: every line wraps in `{ timestamp, type, payload }`. Use the `analyze-codex-session.mjs` script for structured summaries.
- For **Copilot sessions**: full transcripts in `~/.copilot/session-state/<uuid>/events.jsonl`. Use `analyze-copilot-session.mjs` for structured summaries. Board API (`/api/sessions/:id/summary`) also provides parsed output.
- Sessions with 8 lines and no `assistant` entry = the process started but exited before Claude responded. Check for auth errors or process kills.
