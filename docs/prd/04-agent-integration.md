# PRD-04: Agent Integration Architecture

How Claude Code interacts with the kanban board via MCP.

## Integration Model

### Original Architecture
```
Claude Code ←[stdio]→ MCP Server (Rust binary) ←[HTTP]→ REST API ←[SQLx]→ SQLite
```

### Our Architecture (Implemented)
```
Claude Code ←[stdio]→ MCP Server (TypeScript/Node) ←[direct DB]→ SQLite (shared with web server)
```

The MCP server connects directly to the same SQLite database as the web server, eliminating HTTP overhead. Both run as separate processes but share the same DB file.

## MCP Tools

27 tools via stdio JSON-RPC transport using `@modelcontextprotocol/sdk`.

### Two agent integration paths
1. **Workspace agents** (this document) — one Claude Code **CLI subprocess** per task, isolated in a git worktree, resumable via `--resume`. This is the bulk of the doc.
2. **Butler** — a single **warm, in-process** Claude per project via the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), not a subprocess. Conversation context persists across turns; the same MCP tools are wired in via the SDK's `options.mcpServers`. Per-project model picker (live `query.setModel()`) and profile selector (restart), slash-command autocomplete, Stop via `query.interrupt()`, context usage via `getContextUsage()`. It orchestrates board work through the one-step `POST /api/workspaces` launch (never the bare `start_workspace` tool) and reads a bundled on-demand UI guide. Implementation details live in `packages/server/CLAUDE.md` (the "Butler" section).

### Board & Issue Management
| Tool | Input | Output | Purpose |
|------|-------|--------|---------|
| `get_context` | `{projectId?}` | Project info, issue counts, active workspaces | Agent knows current state |
| `get_board_status` | `{projectId?, includeClosed?, tailLines?}` | Per-issue workspace state, session status, diff stats, token usage, last output | Comprehensive dashboard |
| `list_issues` | `{projectId, status?, priority?, tag?, blocked?}` | Issue[] | See what needs doing |
| `get_issue` | `{issueId}` | Issue detail with workspaces and dependencies | Understand the task |
| `create_issue` | `{title, description?, priority?, statusName?}` | Issue (with issueNumber) | Create new tasks |
| `update_issue` | `{issueId, title?, description?, statusName?, priority?}` | Issue | Update task fields |
| `delete_issue` | `{issueId}` | void | Remove issue and cascade |
| `move_issue` | `{issueId, statusName}` | Issue | Move between columns by name |

### Workspace & Session Management
| Tool | Input | Output | Purpose |
|------|-------|--------|---------|
| `list_workspaces` | `{issueId?, status?}` | Workspace[] | See existing workspaces |
| `start_workspace` | `{issueId, branch?, baseBranch?, isDirect?, skillId?, planMode?}` | Workspace (with worktree) | Create workspace + git worktree |
| `merge_workspace` | `{workspaceId}` | void | Merge branch and close workspace |
| `close_workspace` | `{workspaceId}` | void | Close without merging |
| `stop_workspace` | `{workspaceId}` | void | Stop running agent session |
| `delete_workspace` | `{workspaceId}` | void | Delete workspace + cascade |
| `list_sessions` | `{workspaceId}` | Session[] | Session history |
| `get_session_stats` | `{sessionId?, workspaceId?}` | Token usage, cost, duration | Session metrics |
| `read_terminal` | `{sessionId, limit?}` | Last N messages (ANSI-stripped) | Read agent output |

### Code Review
| Tool | Input | Output | Purpose |
|------|-------|--------|---------|
| `get_workspace_diff` | `{workspaceId, baseBranch?}` | Git diff | See what changed |
| `get_diff_comments` | `{workspaceId, filePath?}` | DiffComment[] | Review comments |
| `create_diff_comment` | `{workspaceId, filePath, body, lineNumOld?, lineNumNew?, side?}` | DiffComment | Add review comment |

### Tags & Dependencies
| Tool | Input | Output | Purpose |
|------|-------|--------|---------|
| `list_tags` | — | Tag[] | Available tags |
| `create_tag` | `{name, color?}` | Tag | New tag |
| `add_dependency` | `{issueId, dependsOnId, type}` | Dependency | Link issues (6 types) |
| `remove_dependency` | `{dependencyId}` | void | Unlink issues |

### Agent Skills
| Tool | Input | Output | Purpose |
|------|-------|--------|---------|
| `list_agent_skills` | `{projectId?}` | Skill[] | Built-in + custom skills |
| `get_agent_skill` | `{skillId?, name?}` | Skill with prompt | Skill details |
| `create_agent_skill` | `{name, description, prompt, model?, projectId?}` | Skill | Custom skill |
| `export_agent_skills` | `{targetPath, projectId?, skillNames?}` | void | Export as SKILL.md files |

## Agent Lifecycle

```
1. User creates issue on board: "Fix auth bug"
2. User clicks "New Workspace" on issue
   → One-step: DB record + git worktree + auto-launch agent
3. Agent receives issue title + description as prompt
4. Agent works:
   - Makes code changes in worktree
   - Can interact with board via MCP tools
   - Stream-json output parsed and displayed in real-time
   - Task progress (TodoWrite/TaskCreate) shown on cards
5. Agent completes:
   - Diff shown in workspace panel
   - If auto-review enabled: AI code review runs automatically
   - If auto-merge enabled: workspace auto-merges
6. User reviews diff, provides feedback (optional)
7. User merges or closes workspace
```

## Agent Skill Injection

When a workspace is created with a `skillId`, the skill is written as a `.claude/skills/<name>/SKILL.md` file in the worktree. The agent discovers and invokes skills on demand (progressive disclosure), rather than having the full prompt injected upfront.

Skills support optional model overrides (e.g., "haiku" for quick tasks). The `code-review` skill is used as the review prompt template, supporting `{{branch}}`, `{{baseBranch}}`, `{{issueId}}`, and `{{autoFixInstructions}}` placeholders.

## Agent Configuration

### Settings (via Preferences API)
- **agent_command**: Binary name (default: `claude`)
- **agent_args**: Additional CLI arguments (e.g., `--settings`, `--model`)
- **claude_profile**: Profile name for gateway auth settings files
- **mock_agent**: Toggle mock agent for testing
- **auto_merge**: Auto-merge workspace on agent exit
- **review_auto_fix**: Auto-fix issues found during AI code review

### Per-Issue Settings
- **skipAutoReview**: Skip AI code review for this issue
- **planMode**: Agent runs in plan mode (read-only exploration)

### Per-Workspace Settings
- **isDirect**: Work on main checkout (no worktree)
- **baseBranch**: Override the base branch for diff/merge
- **skillId**: Agent skill to inject

## MCP Server Configuration

In `.claude/settings.json` (project-scoped):
```json
{
  "mcpServers": {
    "agentic-kanban": {
      "command": "node",
      "args": ["packages/mcp-server/src/index.ts"],
      "cwd": "/path/to/agentic-kanban"
    }
  }
}
```

## Workspace Isolation

Each workspace uses a **git worktree** for isolation:
- New branch created from project's default branch (or specified `baseBranch`)
- Worktree directory: `.git-worktrees/<branch-name>` (managed by git)
- Direct workspaces: work in the main checkout (no isolation)

**Decision**: Git worktree chosen for MVP — best balance of isolation and simplicity. Docker containers were rejected as overkill for single-user local use.

## Implementation Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Integration approach | MCP Server (Option A) | Proven pattern from original, stdio transport |
| Language | TypeScript | Same as rest of monorepo, MCP SDK available |
| DB access | Direct SQLite | Simpler than HTTP proxy, shared DB file |
| Agent launch | Subprocess CLI (`child_process.spawn`) | Claude Code CLI with `stream-json` output |
| Workspace isolation | Git worktree | Lightweight, native git, no Docker needed |
| Agent output | stream-json NDJSON parsing | Structured output: thinking, text, tool_use, results |
| Multi-turn | `--resume` with claudeSessionId | Each message spawns new process with session continuity |
