# PRD-04: Agent Integration Architecture

How Claude Code interacts with the kanban board via MCP.

## Integration Model

### Original Architecture
```
Claude Code ←[stdio]→ MCP Server (Rust binary) ←[HTTP]→ REST API ←[SQLx]→ SQLite
```

### Our Architecture (Simplified)
```
Claude Code ←[stdio]→ MCP Server (Python/TS) ←[internal]→ App Server ←[ORM]→ SQLite
```

Key simplification: MCP server and app server can be the **same process**, eliminating HTTP overhead.

## MCP Tools for MVP

### Tier 1: Must Have (MVP)
| Tool | Input | Output | Purpose |
|------|-------|--------|---------|
| `get_context` | `{project_id?}` | Project, issue, workspace metadata | Agent knows current state |
| `list_issues` | `{status?, priority?, tag?}` | Issue[] | See what needs doing |
| `get_issue` | `{issue_id}` | Issue detail | Understand the task |
| `create_issue` | `{title, description?, priority?}` | Issue | Create new tasks |
| `update_issue` | `{issue_id, title?, description?, status?, priority?}` | Issue | Move between columns |
| `list_workspaces` | `{issue_id?}` | Workspace[] | See existing workspaces |
| `start_workspace` | `{issue_id, repo_path}` | Workspace | Create workspace + start agent |
| `get_workspace_diff` | `{workspace_id}` | Diff | See what changed |

### Tier 2: Should Have
| Tool | Input | Output | Purpose |
|------|-------|--------|---------|
| `delete_issue` | `{issue_id}` | void | Clean up |
| `list_tags` | `{project_id}` | Tag[] | Categorization |
| `create_issue_tag` | `{issue_id, tag_id}` | void | Tag issues |
| `stop_workspace` | `{workspace_id}` | void | Stop agent |
| `list_sessions` | `{workspace_id}` | Session[] | Session history |

### Tier 3: Later
| Tool | Input | Output | Purpose |
|------|-------|--------|---------|
| `create_pr` | `{workspace_id, title?}` | PR URL | Create pull request |
| `add_comment` | `{issue_id, file_path?, line?, text}` | Comment | Inline code review |
| `link_workspace_issue` | `{workspace_id, issue_id}` | void | Link existing workspace |

## Context Protocol

When Claude Code is launched for a workspace, it receives:

```json
{
  "project": {
    "id": "...",
    "name": "my-app",
    "repos": [{"path": "/home/user/my-app", "branch": "main"}]
  },
  "issue": {
    "id": "...",
    "title": "Fix authentication bug",
    "description": "Users can't log in when...",
    "priority": "high",
    "tags": ["bug", "auth"]
  },
  "workspace": {
    "id": "...",
    "branch": "fix/auth-bug-1234",
    "working_dir": "/home/user/my-app-worktrees/fix-auth-bug-1234"
  }
}
```

## Agent Lifecycle

```
1. User creates issue on board: "Fix auth bug"
2. User (or agent) moves issue to "In Progress"
3. Workspace created:
   - Git worktree/branch created
   - Agent context injected
   - Claude Code launched via CLI
4. Agent works:
   - Reads issue context via MCP
   - Makes code changes
   - Can update issue status via MCP
5. Agent completes:
   - Diff shown in UI
   - User reviews and provides feedback
   - User merges or requests changes
6. Issue moves to "Done" (or back to "In Progress")
```

## Claude Code Agent SDK Integration

The first iteration will use the **Claude Agent SDK** approach:

### Option A: MCP Server (like original)
- Run a local MCP server alongside the web app
- Claude Code connects via stdio
- Tools defined using MCP protocol

### Option B: Claude Code Hooks
- Use Claude Code's hooks system for event-driven integration
- Pre/post tool use hooks to sync state with the board

### Option C: Agent SDK Direct
- Use the Anthropic Agent SDK to programmatically create and manage Claude Code sessions
- Full control over the agent lifecycle from the web app

**Decision: TBD** - will prototype Option A first (proven pattern from original), then evaluate C.

## Implementation Notes

### MCP Server Config (Claude Code)
In `.claude/settings.json` or project config:
```json
{
  "mcpServers": {
    "agentic-kanban": {
      "command": "agentic-kanban-mcp",
      "args": ["--project", "my-project"]
    }
  }
}
```

### Workspace Working Directory
Each workspace needs a clean working directory. Options:
1. **Git worktree** (original approach) - proper isolation
2. **Simple directory copy** - simpler but larger
3. **Docker container** (original approach) - most isolation but heavy

**Decision: Git worktree for MVP** - best balance of isolation and simplicity.
