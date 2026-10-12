---
name: kanban-workflow
description: Complete guide for using the agentic-kanban board via MCP tools or CLI. Covers status workflow, issue management, workspaces, review, and common patterns.
---

Keep the kanban board in sync with your work. You have two ways to interact with the board:

1. **MCP tools** (preferred when available) — prefix `mcp__agentic-kanban__`
2. **CLI** (fallback, or when no MCP server is running) — `npx agentic-kanban <command>`

Use whichever is available. The workflow rules and status names are the same either way.

## Session constraints

Builder sessions are headless - there is no human at the terminal.
**Never** invoke `ExitPlanMode`, `EnterPlanMode`, or `AskUserQuestion`.
For task tracking, use `TaskCreate` / `TaskUpdate` instead of plan mode.
For clarification needs, make a reasonable assumption, document it in the commit message, and proceed.

## Status Names (exact strings)
Todo → In Progress → In Review → AI Reviewed → Done / Cancelled

## Priority Values
"low" | "medium" | "high" | "critical"

---

## MCP Tools (when available)

| Tool | Purpose |
|------|---------|
| `get_context` | Active project, issue counts, running workspaces |
| `get_board_status` | Full dashboard: issues, workspace state, diff stats, session stats |
| `list_issues` | List issues (filter by status, priority, tag). Descriptions omitted — use `get_issue` for one issue's full text |
| `get_issue` | Full issue details including workspaces and dependencies |
| `create_issue` / `update_issue` / `delete_issue` | Issue CRUD |
| `move_issue` | Move issue to a different status |
| `list_workspaces` / `start_workspace` / `stop_workspace` | Workspace management |
| `get_workspace_diff` | View git diff for a workspace |
| `merge_workspace` / `close_workspace` | Finalize work |
| `list_tags` / `create_tag` | Tag management |
| `list_sessions` / `read_terminal` / `get_session_stats` | Session monitoring |
| `get_diff_comments` / `create_diff_comment` | Code review |
| `add_dependency` / `remove_dependency` | Issue dependency management |

---

## CLI Commands (when no MCP server)

Replace `npx agentic-kanban` with `agentic-kanban` if installed globally.

### Board overview
```
npx agentic-kanban status                        # active issues
npx agentic-kanban status --all                  # include completed
npx agentic-kanban status --watch                # auto-refresh
```

### Issues
```
npx agentic-kanban issue create "Title"                        # create (Todo by default)
npx agentic-kanban issue create "Title" -d "desc" -p high      # with details
npx agentic-kanban issue list                                   # all issues
npx agentic-kanban issue list -s Todo                           # filter by status
npx agentic-kanban issue list -p critical                       # filter by priority
npx agentic-kanban issue get <number>                           # full details
npx agentic-kanban issue move <number> "In Progress"            # move by issue number
npx agentic-kanban issue status <number>                        # workspace + last agent message
npx agentic-kanban issue summary <number>                       # session summary
```

### Workspaces
```
npx agentic-kanban workspace create <issue-id>                  # create git worktree
npx agentic-kanban workspace create <issue-id> --base develop    # from specific branch
npx agentic-kanban workspace list                                # all workspaces
npx agentic-kanban workspace resume <issue-number>               # relaunch agent
npx agentic-kanban workspace review <workspace-id>               # trigger AI review
```

### Dependencies
```
npx agentic-kanban issue dependency list <issue-id>
npx agentic-kanban issue dependency add <issue-id> <target-id> -t depends_on
# Types: depends_on, blocked_by, related_to, duplicates, parent_of, child_of, coupled_with
```

### Project management
```
npx agentic-kanban register <path>                               # register a git repo
npx agentic-kanban register .                                    # register cwd
npx agentic-kanban list                                          # show registered projects
npx agentic-kanban unregister <name-or-id>                       # remove project
```

---

## Step-by-Step Workflow

### 1. Orient yourself
```
# MCP:  get_context → list_issues → get_issue(issueId)
# CLI:  npx agentic-kanban status
```

### 2. Start work — move to In Progress immediately
```
# MCP:  update_issue(issueId, statusName="In Progress")
# CLI:  npx agentic-kanban issue move <N> "In Progress"
```
Never start coding without moving the issue first.

### 3. Update description with progress notes
Use the description field as a shared progress log — update with blockers, decisions, scope changes.
```
# MCP:  update_issue(issueId, description="## Progress\n- Done: X\n- Pending: Y")
# CLI:  (use MCP or REST API for description updates)
```

### 3b. Direct workspaces (isDirect: true)
No separate branch — changes go directly to the default branch. You must still move issue status. The system does NOT auto-review direct workspaces — run a self-review subagent before marking Done.

### 4. Run tests and commit your changes
Mandatory before finishing. While iterating, prefer a fast/filtered command so you don't chase false failures: use the project's flaky-skipping script if it has one (check CLAUDE.md / README / package.json), else run only tests covering your changed files:
```
<test command> --related <changed-files>                       # targeted (preferred for refactoring)
<test command> --related $(git diff --name-only HEAD)          # or derive from git
```
Run the full suite once before marking work ready (or when cross-cutting changes may affect unrelated tests), then stage and commit all changed files with a descriptive message.

**Commit at the green checkpoint:** the instant `tsc -b --noEmit` passes for the packages you touched AND the directly-related tests pass, **commit immediately**; continue polish/extra tests in follow-up commits. Don't batch a multi-step diff into one end-of-task commit — an interruption (crash, hot-reload, timeout) loses all of it. Meaningful work normally shows two or more commits, not one.

### 5. Review
**Branched workspaces:** system auto-launches review after your session exits.
**Direct workspaces:** you must spawn a review subagent yourself before marking Done.
```
# Move to In Review first
# MCP:  update_issue(issueId, statusName="In Review")
# CLI:  npx agentic-kanban issue move <N> "In Review"
```

### 6. Close the issue
**Branched workspaces:** Done is set automatically by `merge_workspace` — do NOT call `update_issue(statusName="Done")` manually. Doing so before merging strands the branch and causes silent merge loss.
**Direct workspaces only** (isDirect: true — no separate branch):
```
# MCP:  update_issue(issueId, statusName="Done")
# CLI:  npx agentic-kanban issue move <N> "Done"
```
Only after: code committed, tests pass, review passed.

### 7. Cancel if abandoned
```
# MCP:  update_issue(issueId, statusName="Cancelled")
# CLI:  npx agentic-kanban issue move <N> "Cancelled"
```

---

## Common Patterns

### "I'm starting work right now"
Move to In Progress before any file edits.

### "I'm blocked — flagging for the user"
Set priority to high and describe the blocker in the issue description.

### "Check what I've changed so far"
```
# MCP:  list_workspaces → get_workspace_diff
# CLI:  npx agentic-kanban issue status <N>
```

### "Review #N and merge"
`#N` always means a kanban board issue, never a GitHub PR.
```
# MCP:  get_board_status → get_workspace_diff → merge_workspace
# CLI:  npx agentic-kanban issue status <N> → (use REST API for merge)
```
**Note:** `merge_workspace` merges the branch AND auto-transitions the issue to Done.
Do NOT call `update_issue(statusName="Done")` separately — it is redundant and will be blocked if the workspace is still open.

---

## Rules of Thumb

1. **Move first, code second** — update to In Progress before any file edits.
2. **Every commit gets reviewed** — no workspace skips review.
3. **Board reflects reality** — move statuses in real-time, don't batch.
4. **Complete the full ticket** — if the ticket lists steps, do all of them.
5. **Commit before review** — never trigger review with uncommitted changes.
6. **Commit at the green checkpoint** (see Step 4) — never batch a multi-step diff into one end-of-task commit; an interruption loses all of it.
7. **Description is a shared log** — write progress notes so the user can follow along.
8. **Done means done** — code committed, tests green, review passed, no loose ends.
9. **Cancelled is not failure** — use it freely when scope changes.