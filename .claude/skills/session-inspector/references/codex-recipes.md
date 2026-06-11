# Codex sessions — event format + manual inspection

Primary path is `node scripts/analyze-codex-session.mjs --latest` (structured
summary: model, duration, turns, tool usage, commands, patches, web searches,
last 5 agent messages). These are the manual fallbacks.

Codex session files are at `~/.codex/sessions/YYYY/MM/DD/`. Each file is a JSONL where every line is `{ timestamp, type, payload }`.

## Event types

| Type | Description |
|------|-------------|
| `session_meta` | Session initialization: id, cwd, model_provider, cli_version, base_instructions |
| `event_msg` | Lifecycle events: `user_message`, `agent_message`, `task_started`, `task_complete`, `token_count`, `patch_apply_end`, `web_search_end`, `context_compacted`, `thread_rolled_back`, `thread_goal_updated` |
| `response_item` | Model response items with subtypes: `message` (assistant text), `reasoning` (encrypted), `function_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output`, `tool_search_call`, `web_search_call` |
| `turn_context` | Turn metadata: model, cwd, approval_policy, sandbox_policy |
| `compacted` | Context window compaction event |

## List recent Codex sessions

```powershell
Get-ChildItem "$env:USERPROFILE\.codex\sessions" -Recurse -Filter "*.jsonl" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 10 |
  ForEach-Object {
    $size = "$([math]::Round($_.Length/1KB))KB"
    "  $($_.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))  $size  $($_.Name.Substring(0,[math]::Min(60,$_.Name.Length)))"
  }
```

## Parse Codex session tail

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

## Detect Codex launch failures

If `analyze-codex-session.mjs` reports `Duration: 1s`, `Tokens: 0 in / 0 out`, and no assistant text, the process received a prompt but never executed a model turn. Treat the related board session as launch-failed or stale instead of waiting longer; stop the workspace session and inspect the worktree/branch directly.

## Find user messages in a Codex session

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
