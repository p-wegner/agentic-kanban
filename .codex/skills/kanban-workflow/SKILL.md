---
name: kanban-workflow
description: Guide for using the agentic-kanban MCP tools to reflect implementation progress on the board. Use when starting work on an issue, moving through implementation steps, reviewing completed work, or closing out a task.
argument-hint: [issue-id or issue-number]
---

# Kanban Workflow — Reflecting Implementation Steps on the Board

Use the **agentic-kanban MCP** tools (prefix: `mcp__agentic-kanban__`) to keep the board in sync with your actual work.

## Available MCP Tools

| Tool | Purpose |
|------|---------|
| `get_context` | Get current project, issue counts by status, active workspaces |
| `get_board_status` | Comprehensive dashboard: all issues with workspace state, diff stats, session stats, last output |
| `list_issues` | List issues (filter by status, priority, tag) |
| `get_issue` | Get full details for a specific issue (includes workspaces and dependencies) |
| `create_issue` | Create a new issue on the board |
| `update_issue` | Move an issue to a new status, change title/description/priority |
| `delete_issue` | Permanently delete an issue |
| `move_issue` | Move an issue to a different status (shorthand) |
| `list_workspaces` | List workspaces (filter by issue ID) |
| `start_workspace` | Create a git worktree workspace for an issue |
| `merge_workspace` | Merge a workspace branch and close it |
| `stop_workspace` | Stop a running agent session |
| `get_workspace_diff` | Get the git diff for a workspace |
| `list_tags` | List all tags |
| `create_tag` | Create a new tag |
| `list_sessions` | List sessions for a workspace |
| `read_terminal` | Read last N lines of terminal output for a session |
| `get_session_stats` | Get token usage, cost, and duration for a session |

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
update_issue(issueId, description="## Progress\n- Schema migrated\n- API route WIP\n- UI pending")
```

### 4b. Direct workspaces (isDirect: true)
Some workspaces have `isDirect: true` — the agent is working directly on the project's default branch (e.g. master) instead of a separate feature branch. In this case:
- There is no separate branch to merge — changes go directly to master.
- **You must still move the issue status** when done. Do not skip status transitions just because there is no branch to merge.
- **The system does NOT auto-review direct workspaces.** You must self-review before committing (see step 5a below).
- After self-review and commit, move to **Done**.
- The absence of a feature branch is NOT a reason to leave the ticket in "In Progress" forever.

### 5. Self-review before committing
**This is mandatory for direct workspaces and strongly recommended for all workspaces.** Before you commit:

1. **Read the full diff** — run `git diff` (or `git diff --staged` if already staged). Do not skip this. You must see every line you're about to commit.
2. **Review your own changes critically** — look for correctness bugs, security issues, dead code, forgotten debug output, missing error handling.
3. **Complete the ticket's checklist** — if the ticket description lists remaining steps, complete ALL of them before committing. Do not ask the user for permission to skip steps listed in the ticket. If a step is genuinely blocked, note it in the issue description and move the issue to the appropriate status — but do not commit partial work and mark Done.
4. **Verify the commit is complete** — the commit should represent a coherent, reviewable unit of work.

### 5a. Commit your changes
After self-review, commit:
1. Stage and commit all changed files with a descriptive message
2. The commit message should summarize the what and why
3. Reference the issue in the commit if appropriate

Do NOT leave uncommitted changes in the worktree. If you have made changes, commit them before moving to the next step.

### 6. Move to In Review when code is ready
After committing on a **branched workspace**, move the issue to **In Review**:
```
update_issue(issueId, statusName="In Review")
```
This signals that the implementation is complete and ready for review. An automated code review will be triggered.

**For direct workspaces**: skip this step. You already self-reviewed in step 5. Move directly to **Done** after committing.

### 7. AI Code Review (automatic, branched workspaces only)
When auto-review is enabled and the workspace has a feature branch, the system launches a review agent after your session exits. The board shows a purple **AI Reviewing** badge on the issue card during review.

**Review agent behavior:**
- Reviews the git diff for correctness, security, and code quality
- If **CRITICAL or MAJOR** issues found: moves issue to **In Progress**, fixes the issues, commits, then exits → system auto-merges
- If **only MINOR or no issues**: exits normally → system auto-merges and moves to **AI Reviewed**
- If review agent crashes (non-zero exit): issue stays where it is, no merge happens

The review-then-fix loop is: implement → review → fix (if needed) → merge. No manual intervention required.

### 8. Close the issue
After review approval:
```
update_issue(issueId, statusName="Done")
```
Do this only after the work is actually complete (tests pass, code committed, review approved). Do **not** mark Done while work is still in progress.

### 9. Cancel if work is abandoned
```
update_issue(issueId, statusName="Cancelled")
```
Use **Cancelled** for issues that are no longer relevant or were superseded. Add a note in the description explaining why.

## Status Names (exact strings)

The board has 6 statuses. Pass these exact strings to `statusName`:
- `"Todo"` — not started
- `"In Progress"` — actively being worked on
- `"In Review"` — implementation complete, awaiting review
- `"AI Reviewed"` — passed automated code review, ready to merge
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
# 1. Commit all changes
# 2. Move to In Review
update_issue("<id>", statusName="In Review")
```

### "I'm blocked — flagging for the user"
```
update_issue("<id>", description="<existing description>\n\n## Blocked\n<describe the blocker>", priority="high")
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

### "Review a completed task"
```
get_workspace_diff(workspaceId)   → see all changes
get_session_stats(sessionId)      → see token usage and cost
```

### "Review #N and merge if fine"

When the user says "review #N" or "review #N and merge", this refers to **board issue #N**, not a GitHub PR. Follow this exact workflow:

1. **Find the issue** — use `get_board_status` or `list_issues` to find the issue by `issueNumber`
2. **Find the workspace** — the issue's workspace is shown in the board data (or use `list_workspaces` with the issue ID)
3. **Review the diff** — use `get_workspace_diff(workspaceId)` to see all changes
4. **Assess the changes** — look for correctness, security issues, broken patterns, missing cleanup
5. **If fine: merge** — use the merge REST endpoint (`POST /api/workspaces/:id/merge`) or workspace merge action
6. **Move to Done** — use `update_issue(issueId, statusName="Done")`
7. **If not fine: report issues** to the user and leave the issue in its current status

**Never assume `#N` means a GitHub PR.** This project uses manual merge (no PRs). The `#N` format always refers to a kanban board issue number.

### "Merge #N"

Shorthand for "review #N and merge if fine" — same workflow as above.

## Rules of Thumb

1. **Move first, code second** — update to In Progress before any file edits.
2. **Read your diff before committing** — always `git diff` your changes. Never commit blind.
3. **Complete the full ticket** — if the ticket lists steps, do all of them. Do not ask the user for permission to skip checklist items. If blocked, note it in the description and stop — don't mark Done.
4. **Commit before moving to In Review** — never leave uncommitted changes when signaling completion.
5. **One status transition per logical checkpoint** — don't batch-move issues after the fact.
6. **Description is a shared log** — write progress notes so the user can follow along without reading code.
7. **Done means done** — code committed, tests green, review approved (or self-reviewed for direct), no loose ends, no open questions.
8. **Cancelled is not failure** — use it freely when scope changes.
