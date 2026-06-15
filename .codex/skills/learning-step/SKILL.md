---
name: learning-step
description: Analyze agent session data (kanban sessions, JSONL transcripts, or inline context), detect friction points, and produce targeted improvements to documentation, hooks, skills, or code.
argument-hint: "[--issue <N>] [--last] [--session <path>] [--analysis-only]"
---

# Learning Step — Agent Interaction Analysis

Analyze past agent interactions to find friction and improve future sessions. You are a diagnostic + improvement tool.

## Input modes (from arguments)

**No arguments (inline)** — you're a subagent; the parent conversation IS the session data. Analyze what you can see (what the agent did, what went wrong, what took extra turns); skip data collection. If the inline context has a structured session handoff, treat it as primary evidence — the feature worktree may already be clean/merged/emptied by board cleanup, so don't treat an empty/missing worktree as a blocker; fall back to the handoff, commit hash, changed-file list, test result, and any local transcript snippets.
If the handoff names a "Last Commit" and the worktree still exists, verify it with `git rev-parse --short HEAD` before using or reporting that SHA; handoff commit hashes can be stale after later commit rewriting or regenerated summaries.

**`--issue <N>`** — fetch structured data for kanban issue #N:
```powershell
$status = Invoke-RestMethod "http://localhost:3001/api/issues?projectId=f6046402-8373-4294-9624-e0e4e54e1961&issueNumber=<N>"
$ws = Invoke-RestMethod "http://localhost:3001/api/issues/$($status[0].id)/workspaces"
$summary = Invoke-RestMethod "http://localhost:3001/api/sessions/$sessionId/summary"
```
Or, preferred when available: `pnpm cli -- session analyze <session-id>`.

**`--last`** — analyze the most recent sessions: `pnpm cli -- session recent --limit 5`, then `session analyze` each. **⚠️ In a worktree, `pnpm cli --` fails with `ERR_MODULE_NOT_FOUND`** (`packages/shared/dist` unbuilt) — query the `session_store` DB directly, then read checkpoints/turns for the interesting IDs:
```sql
SELECT s.id, s.branch, substr(s.summary,1,120), s.updated_at, COUNT(t.turn_index) AS turns
FROM sessions s LEFT JOIN turns t ON t.session_id = s.id
WHERE s.repository = 'p-wegner/agentic-kanban'
GROUP BY s.id HAVING turns > 0 ORDER BY s.updated_at DESC LIMIT 10;
```

**`--session <path>`** — read a JSONL transcript (session-inspector patterns): `Get-Content $path -Tail N` (never the whole file); parse each line with `ConvertFrom-Json -ErrorAction SilentlyContinue`; extract `tool_use` (name+input), `tool_result` (is_error+content), assistant text blocks.

**`--analysis-only`** — produce the report but apply no changes.

## Friction patterns (scan each session)

| # | Pattern | Signal | Ask |
|---|---|---|---|
| 1 | **Wasted turns** | Many Read/Bash before finding the target; backtracking; `--json` with `pnpm cli --` (known to fail) | Could a doc/skill/CLI command have cut these turns? |
| 2 | **Wrong tool** | `curl` not `Invoke-RestMethod`; `cat`/`grep` not Read/Grep; `find` not Glob; piped to `jq` (absent on Windows) | Doc gap or missing tool? |
| 3 | **Missing knowledge** | Discovers a feature mid-session; uses REST manually when MCP/CLI exists; doesn't know `workspace resume` / `issue status` | CLAUDE.md, memory file, or skill prompt? |
| 4 | **Repeated errors** | Same error 2+ times (`toolUsePatterns[].failedCount`, `errors[]`); retries a failing command (`repeatedCommands[]`) | Could a hook catch it, or a better error message guide it? |
| 5 | **Incomplete session** | status `stopped` not `completed`; last message mid-thought; issue not moved to correct status | Process gap (no reminder) or infra failure? |
| 6 | **Model-specific** | Haiku reading "resume" as "investigate yourself", wasting turns on flag bugs, ignoring CLAUDE.md task→command tables | Should CLAUDE.md add model-specific guidance? |
| 7 | **Rate limiting** | `rateLimits` has entries; long stalls | Could the agent have used fewer tool calls? |

## Improvement classification + application rules

For each friction point, classify the fix and apply per these constraints:

| Type | Target | When | Rules |
|---|---|---|---|
| **Documentation** | memory files, CLAUDE.md, `.llm/workflows.md` | agent lacked knowledge | 1-3 lines, never removal. Memory: create in `C:\Users\pwegner\.claude\projects\C--andrena-agentic-kanban\memory\` as `pitfall_/pattern_/feedback_<topic>.md` with frontmatter `type: feedback` (or `project`), AND add an index entry to `MEMORY.md`. CLAUDE.md: Architecture Patterns sections (root, client, server). |
| **Skill update** | `.claude/skills/*/SKILL.md` | a skill prompt missed a step | preserve frontmatter + structure, add guidance |
| **Hook addition** | `.claude/hooks/` config | failure mode is mechanically preventable | suggest the pattern, never weaken existing hooks |
| **Code** | CLI / REST / MCP tools | a missing tool would prevent friction | implement simple additions; flag complex architectural ones for user review |

**Committing:** `docs: learning step -- <short key finding>`. **Verify it landed** — run `git log --oneline -2` and confirm the SHA; do NOT report a commit in "Changes Applied" without seeing the hash (prior sessions falsely reported applied-without-committing).

## Output format

```
## Learning Step Report
**Session**: #N <title> | Model: <model> | Duration: <duration>
**Source**: <kanban-session | jsonl-transcript | inline>
**Tool patterns**: <top 5 by count>   **Repeated commands**: <run 2+ times>
**Errors**: <count>   Rate limits: <count>

### Friction Points
#### FP-1: <one-line description>
- Evidence: <quote, max 2 lines>   Turns wasted: <N> (est)   Severity: low/med/high

### Improvements
#### IMP-1: <action title>
- Addresses: FP-<N>   Type: <doc|skill|hook|code>   Target: <path>
- Change: <what to add/modify>   Priority: low/med/high

### Changes Applied
- <file> -- <what was added>   (or "None -- --analysis-only" / "None -- no actionable improvements")

### Skipped (below threshold)
- <minor observation>
```

## Quality gates (verify before emitting each improvement)

1. **Non-obvious** — any experienced dev would know it → skip.
2. **Project-specific** — generic advice is noise.
3. **Actionable** — the reader knows exactly what to do.
4. **Non-duplicative** — check existing memory files + CLAUDE.md first.
5. **Not already in this branch** — check `git log --oneline master..HEAD` for prior learning-step commits on the same finding.

Skip improvements failing any gate. A clean report beats a noisy one.
