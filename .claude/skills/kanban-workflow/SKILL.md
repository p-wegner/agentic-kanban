---
name: kanban-workflow
description: Guide for using the agentic-kanban MCP tools to reflect implementation progress on the board. Use when starting work on an issue, moving through implementation steps, or closing out a task.
argument-hint: [issue-id or issue-number]
---

# Kanban Workflow — Reflecting Implementation Steps on the Board

Use the **agentic-kanban MCP** tools (prefix: `mcp__agentic-kanban__`) to keep the board in sync with your actual work.

## Available MCP Tools

| Tool | Purpose |
|------|---------|
| `get_context` | Get current project, issue counts by status, active workspaces |
| `list_issues` | List issues (filter by status, priority, tag) |
| `get_issue` | Get full details for a specific issue |
| `create_issue` | Create a new issue on the board |
| `update_issue` | Move an issue to a new status, change title/description/priority |
| `list_workspaces` | List workspaces (filter by issue ID) |
| `start_workspace` | Create a git worktree workspace for an issue |
| `get_workspace_diff` | Get the git diff for a workspace |

## Step-by-Step Workflow

### 1. Orient yourself
```
get_context          → see active project, open issues, running workspaces
list_issues          → get issue IDs; filter with statusName="Todo"
get_issue(issueId)   → read title, description, current status
```

### 2. Start work on an issue
Move it to **In Progress** immediately when you begin:
```
update_issue(issueId, statusName="In Progress")
```
This is a hard rule — never start coding without moving the issue first. It gives the user live board feedback.

### 3. Break down work (optional but recommended)
If the issue is large, create sub-issues to track each step:
```
create_issue(title="Step 1: …", description="…", priority="medium")
```
Move each sub-issue to **In Progress** when you start it, **Done** when you finish.

### 4. Update description with progress notes
Use `update_issue` to log blockers, decisions, or scope changes in the description field — this is the only shared state between you and the user:
```
update_issue(issueId, description="## Progress\n- ✅ Schema migrated\n- 🔄 API route WIP\n- ⬜ UI pending")
```

### 5. Move to review when code is ready
```
update_issue(issueId, statusName="In Review")
```
Use **In Review** if the work needs human sign-off (PR, design review, testing). Skip this status and go straight to Done if no review is needed.

### 6. Close the issue
```
update_issue(issueId, statusName="Done")
```
Do this only after the work is actually complete (tests pass, code committed). Do **not** mark Done while work is still in progress.

### 7. Cancel if work is abandoned
```
update_issue(issueId, statusName="Cancelled")
```
Use **Cancelled** for issues that are no longer relevant or were superseded. Add a note in the description explaining why.

## Status Names (exact strings)

The board has 5 statuses. Pass these exact strings to `statusName`:
- `"Todo"` — not started
- `"In Progress"` — actively being worked on
- `"In Review"` — waiting for review/approval
- `"Done"` — complete
- `"Cancelled"` — abandoned/irrelevant

## Priority Values

Pass to `priority` param: `"low"` | `"medium"` | `"high"` | `"critical"`

## Common Patterns

### "I'm starting work right now"
```
update_issue("<id>", statusName="In Progress")
```

### "I finished this task"
```
update_issue("<id>", statusName="Done")
```

### "I'm blocked — flagging for the user"
```
update_issue("<id>", description="<existing description>\n\n## 🚧 Blocked\n<describe the blocker>", priority="high")
```

### "This issue is too big — splitting it"
```
create_issue(title="Part 1: …")
create_issue(title="Part 2: …")
update_issue("<original-id>", statusName="Cancelled", description="Split into #X and #Y")
```

### "Check what I've changed so far"
```
list_workspaces(issueId="<id>")   → get workspaceId
get_workspace_diff(workspaceId)   → see git diff
```

## Rules of Thumb

1. **Move first, code second** — update to In Progress before any file edits.
2. **One status transition per logical checkpoint** — don't batch-move issues after the fact.
3. **Description is a shared log** — write progress notes so the user can follow along without reading code.
4. **Done means done** — code committed, tests green, no loose ends.
5. **Cancelled is not failure** — use it freely when scope changes.
