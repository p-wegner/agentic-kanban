---
name: session-inspector
description: Inspect Claude Code agent session transcripts from ~/.claude/projects/ to debug why sessions stopped, what they did, and whether they produced output. Use when diagnosing stopped agents, "no response" sessions, or tracing what an agent actually did.
argument-hint: [issue-number or keyword]
---

# Session Inspector — Debugging Agent Session Transcripts

Claude Code stores full JSONL transcripts for every session under `~/.claude/projects/`, one directory per working directory path. This skill lets you parse those files efficiently without loading entire large files.

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

## Tips

- **Never `Get-Content` a large JSONL without `-Tail`** — some files are 1-2MB+ and will flood the terminal.
- Each line is a self-contained JSON object; parse line-by-line with `ConvertFrom-Json -ErrorAction SilentlyContinue`.
- The `sessionId` field is on most entries and matches the filename (minus `.jsonl`).
- `ai-title`, `queue-operation`, `attachment` entries are metadata — only `user` and `assistant` entries carry content.
- Sessions with 8 lines and no `assistant` entry = the process started but exited before Claude responded. Check for auth errors or process kills.
