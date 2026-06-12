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

## Start here — structured single-session analyzers

For ONE session, this is the fast path for every provider. Each prints a structured summary (model, duration, turns, tool usage, commands run, tool-failure counts, repeated commands, last agent messages):

```powershell
node scripts/analyze-claude-session.mjs  --latest   # or <path> | --list [--worktrees] | --json
node scripts/analyze-codex-session.mjs   --latest
node scripts/analyze-copilot-session.mjs --latest
```

### Style & ranking — "which session, and how did it read?"

For *style* questions ("describe the prompting / output style", "which session wrote the most") use these two — they compute aggregate signals + pull representative samples, so you characterize a session **without reading all its tokens**:

```powershell
node scripts/session-rank.mjs --by output         # rank this project's sessions: prompts|output|turns|duration|cost
node scripts/output-style.mjs <file>              # ASSISTANT output style: tool mix, prose:tool ratio, silent-turn %, length dist, formatting tics, longest prose
node scripts/output-style.mjs <file> --human      # PROMPTING style: human prompt count, length dist, lowercase/imperative/question %, opening tics, all prompts
node scripts/output-style.mjs --copilot --builders  # FLEET aggregate across ALL Copilot builder sessions (one merged profile)
node scripts/output-style.mjs --fleet <dir> --top 50  # aggregate any dir of sessions; --top N caps to N largest
```

Workflow: `session-rank` to find the session, then `output-style` (assistant) or `--human` (prompting) to profile it. `output-style` auto-detects **Claude** (`*.jsonl`) vs **Copilot** (`events.jsonl`) format and aggregates a fleet into ONE profile when given `--copilot`/`--fleet` (use `--builders` to keep only worktree/feature sessions). `--json` on either for machine-readable. `session-rank`'s `prompts` count is REAL human prompts (filters tool_results + `<task-notification>` echoes). Caveats: Claude thinking-block *text* is stripped (signature only → reasoning-words shows 0; Copilot keeps `reasoningText` so its reasoning volume IS measured); `--top N` (fleet) is a size pre-filter that biases toward the chattiest sessions — omit it for a representative aggregate. Key builder signal it surfaces: **silent-turn %** (turns that fire tools with zero prose).

When the analyzer isn't enough and you need custom parsing, load the matching **manual recipe file** (PowerShell snippets, loaded on demand):
- `references/claude-recipes.md` — find a session by issue #, quick overview, parse tail, detect "started but never responded", read last message / sent prompt, find by `stop_reason`.
- `references/codex-recipes.md` — Codex `{timestamp,type,payload}` event types, list, parse tail, launch-failure detection, find user messages.
- `references/copilot-recipes.md` — Copilot `events.jsonl` event types, manual parse, **board-API read** (works when local files are gone), workspace correlation, process logs, common-issue symptoms.

## Per-session vs fleet (which skill?)

This skill debugs **one** session. For **aggregate, time-scoped questions across MANY sessions** — "which tools fail most in the last 48h", "what's burning tokens", "what did I ask yesterday" — do **not** loop the per-session recipes:
- **Server-side friction roll-up** → the **`fleet-analysis`** skill: `GET /api/insights?projectId=<id>&hours=48` → `.friction { byTool, topRepeatedCommands, worstSkills, failPct, coverage }`. Backfill once for coverage: `pnpm cli -- session backfill-friction --hours 48` (main checkout); MCP shortcut `mcp__agentic-kanban__get_fleet_friction { hours }`.
- **Standalone fan-out scripts** (token sinks, tool failures, user prompts) — full usage + caveats in `references/aggregate-tools.md`.

## Directory naming convention (Claude)

Each working directory maps to a session dir by replacing path separators with `--`:
- `C:\andrena\.worktrees\feature_ak-17-...` → `C--andrena--worktrees-feature-ak-17-...`
- `C:\andrena\agentic-kanban\packages\.worktrees\feature_ak-N-...` → `C--andrena-agentic-kanban-packages--worktrees-feature-ak-N-...`

Multiple `.jsonl` files in one dir = multiple sessions (e.g. original run + re-launched review). Sort by `LastWriteTime` descending to find the latest.

## Common stop_reason values and what they mean (Claude)

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
- For **Claude sessions**: the `sessionId` field is on most entries and matches the filename (minus `.jsonl`). `ai-title`, `queue-operation`, `attachment` entries are metadata — only `user` and `assistant` entries carry content.
- For **Codex sessions**: every line wraps in `{ timestamp, type, payload }`. Use the `analyze-codex-session.mjs` script for structured summaries.
- For **Copilot sessions**: full transcripts in `~/.copilot/session-state/<uuid>/events.jsonl`. Use `analyze-copilot-session.mjs` for structured summaries. Board API (`/api/sessions/:id/summary`) also provides parsed output.
- Sessions with 8 lines and no `assistant` entry = the process started but exited before Claude responded. Check for auth errors or process kills.
