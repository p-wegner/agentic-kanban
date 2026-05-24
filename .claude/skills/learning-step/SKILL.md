---
name: learning-step
description: Analyze agent session data (kanban sessions, JSONL transcripts, or inline context), detect friction points, and produce targeted improvements to documentation, hooks, skills, or code.
argument-hint: [--issue <N>] [--last] [--session <path>] [--analysis-only]
---

# Learning Step — Agent Interaction Analysis

You analyze past agent interactions to identify friction and improve future sessions. You are a diagnostic and improvement tool.

## Input Modes

Determine your input mode from the arguments:

### No arguments (inline)
You were called as a subagent. The parent conversation IS the session data. Analyze what you can see — what the agent did, what went wrong, what took extra turns. Skip data collection.

### `--issue <N>`
Fetch structured session data for kanban issue #N:

```powershell
# Get workspace + session metadata
$status = Invoke-RestMethod "http://localhost:3001/api/issues?projectId=f6046402-8373-4294-9624-e0e4e54e1961&issueNumber=<N>"
$ws = Invoke-RestMethod "http://localhost:3001/api/issues/$($status[0].id)/workspaces"
# Get session summary
$summary = Invoke-RestMethod "http://localhost:3001/api/sessions/$sessionId/summary"
```

Or use the CLI (preferred when available):
```bash
pnpm cli -- session analyze <session-id>
```

### `--last`
Analyze the most recent agent sessions:

```bash
pnpm cli -- session recent --limit 5
```

Then pick the most interesting sessions and run `session analyze` on each.

### `--session <path>`
Read a specific JSONL transcript file. Use session-inspector patterns:
- Always use `Get-Content $path -Tail N` (never read the whole file)
- Parse each line with `ConvertFrom-Json -ErrorAction SilentlyContinue`
- Extract `tool_use` blocks (name + input), `tool_result` blocks (is_error + content), assistant text blocks

### `--analysis-only`
Produce the improvement report but do not apply changes. Useful for review before committing.

## Analysis Framework

For each session, scan for these friction patterns:

### 1. Wasted Turns
**Signal**: Multiple Read/Bash calls before finding the right target, obvious backtracking, or trying `--json` with `pnpm cli --` (known to fail).
**Ask**: Could a better doc entry, skill prompt, or CLI command have cut these turns?

### 2. Wrong Tool Choice
**Signal**: Agent used `curl` instead of `Invoke-RestMethod`, `cat`/`grep` instead of Read/Grep tools, Bash `find` instead of Glob, piped to `jq` (not available on Windows).
**Ask**: Is this a documentation gap or a missing tool?

### 3. Missing Knowledge
**Signal**: Agent discovers a feature mid-session ("oh, there's a CLI command for this"), uses REST API manually when MCP/CLI tool exists, doesn't know about `workspace resume` or `issue status`.
**Ask**: Should this be in CLAUDE.md, a memory file, or a skill prompt?

### 4. Repeated Errors
**Signal**: Same error 2+ times (check `toolUsePatterns[].failedCount` and `errors[]`), or agent retrying the same failing command (check `repeatedCommands[]`).
**Ask**: Could a hook catch this? Could a better error message guide the agent?

### 5. Incomplete Session
**Signal**: Session status is "stopped" not "completed", last agent message is mid-thought, or issue was not moved to correct status after work.
**Ask**: Was this a process gap (no reminder) or infrastructure failure?

### 6. Model-Specific Behavior
**Signal**: Haiku misinterpreting "resume" as "investigate yourself", wasting turns on flag bugs, or not following CLAUDE.md task→command tables.
**Ask**: Should CLAUDE.md include model-specific guidance?

### 7. Rate Limiting
**Signal**: `rateLimits` array has entries, or session stalled for long periods.
**Ask**: Could the agent have been more efficient with fewer tool calls?

## Improvement Classification

For each friction point, classify the fix:

| Type | Target | When | Constraint |
|---|---|---|---|
| Documentation | Memory files, CLAUDE.md, `.llm/workflows.md` | Agent lacked knowledge | 1-3 line addition, never removal |
| Skill update | `.claude/skills/*/SKILL.md` | Skill prompt was missing a step | Preserve structure, add guidance |
| Hook addition | `.claude/hooks/` | Failure mode could be mechanically prevented | Suggest pattern, never weaken hooks |
| Code improvement | CLI commands, REST, MCP tools | Missing tool would prevent friction | Implement simple additions; flag complex ones |

## Output Format

```
## Learning Step Report

**Session**: #N <title> | Model: <model> | Duration: <duration>
**Source**: <kanban-session | jsonl-transcript | inline>
**Tool patterns**: <top 5 tools by count>
**Repeated commands**: <commands run 2+ times>
**Errors**: <count> | Rate limits: <count>

### Friction Points

#### FP-1: <one-line description>
- **Evidence**: <quote from session data, max 2 lines>
- **Turns wasted**: <N> (estimated)
- **Severity**: low/medium/high

### Improvements

#### IMP-1: <action title>
- **Addresses**: FP-<N>
- **Type**: <documentation | skill-update | hook | code>
- **Target**: <file path>
- **Change**: <what to add/modify>
- **Priority**: low/medium/high

### Changes Applied
- <file> -- <what was added>
- (or "None -- --analysis-only" or "None -- no actionable improvements")

### Skipped (below threshold)
- <minor observation>
```

## Application Rules

### Memory files
Create in `C:\Users\pwegner\.claude\projects\C--andrena-agentic-kanban\memory\`.
File name: `pitfall_<topic>.md`, `pattern_<topic>.md`, or `feedback_<topic>.md`.
Frontmatter must include `type: feedback` (or `project`).
Must add entry to `MEMORY.md` index.

### CLAUDE.md
May add to Architecture Patterns sections in root, `packages/client/CLAUDE.md`, `packages/server/CLAUDE.md`.
1-3 lines per finding. Never remove existing entries.

### Hooks
May add patterns to `.claude/hooks/` config files.
Never weaken existing hooks.

### Skills
May edit `.claude/skills/*/SKILL.md`.
Preserve frontmatter and section structure.

### Code
May implement simple additions (new CLI commands, API endpoints, MCP tool improvements).
Flag complex architectural changes for user review.

### Committing
After applying changes, commit with: `docs: learning step -- <short description of key finding>`

## Quality Gates

Before outputting each improvement, verify:
1. **Non-obvious?** If any experienced developer would know it, skip.
2. **Project-specific?** Generic advice is noise.
3. **Actionable?** The reader must know exactly what to do.
4. **Non-duplicative?** Check existing memory files and CLAUDE.md before adding.

Skip improvements that fail any gate. A clean report is better than a noisy one.
