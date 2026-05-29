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
- **The system does NOT auto-review direct workspaces.** You must run a self-review subagent before committing (see step 5 below).
- The absence of a feature branch is NOT a reason to leave the ticket in "In Progress" forever.

### 5. Run tests and commit your changes
**This is mandatory before finishing.** After implementation is complete:
1. **Run tests** — for refactoring tasks, run only the tests relevant to changed files.
   **Important**: vitest v4 moved `--related` to a subcommand — the `--related` flag no longer works.
   ```
   # Targeted (correct in vitest v4):
   cd packages/server && node node_modules/vitest/vitest.mjs related src/services/foo.service.ts
   # Or derive from git:
   cd packages/server && node node_modules/vitest/vitest.mjs related $(git diff --name-only HEAD | grep "^packages/server" | sed 's|packages/server/||')
   # Fast iteration via pnpm (safe subset, no known-flaky tests):
   pnpm test:mine
   ```
   Only run the full suite (`pnpm --filter agentic-kanban test`) when cross-cutting changes may affect unrelated tests, or as a final pre-commit check.
2. Stage and commit all changed files with a descriptive message
3. The commit message should summarize the what and why
4. Reference the issue in the commit if appropriate

Do NOT leave uncommitted changes in the worktree. If you have made changes, commit them before moving to the next step.

### 6. Run a code review
**Every workspace must be reviewed before closing — no exceptions.** How the review happens depends on the workspace type:

#### Branched workspaces (automatic)
After your session exits, the system automatically launches a review subagent. The board shows a purple **AI Reviewing** badge during review. You don't need to do anything — the system handles the full review-then-fix-then-merge cycle.

**Do NOT call any REST endpoint to trigger the review.** There is no `/propose-transition` or `/review-trigger` endpoint. The transition happens automatically when your Claude Code session exits. Just commit, run tests, and exit normally.

**Visual verification note:** If the project has `visual_verification_mode = "after_merge"` (Settings → Workflow), you are **not** required to verify the UI before stopping. The server will detect any client file changes and tag the issue with `needs-visual-verification` at merge time. If `visual_verification_mode = "before_merge"` (default), the stop hook will block you until you run `/playwright-cli` and confirm the UI renders correctly.

#### Direct workspaces (you must trigger it)
The system does NOT auto-review direct workspaces. You must launch a review subagent yourself **before marking the issue Done**:

1. **Move the issue to In Review** so the board reflects the current state:
   ```
   update_issue(issueId, statusName="In Review")
   ```
2. **Spawn a review subagent** using the project's code-review skill. Use your agent's subagent mechanism (e.g. `spawn_agent` for Codex, `Agent` tool for Claude Code):
   - Pass the diff context: what files changed, the commit message, and the issue description
   - Respect the user's review settings:
     - **Normal review** (`thorough_review: false` or unset): use the `code-review` skill — focused on correctness bugs, security, logic errors
     - **Thorough review** (`thorough_review: true`): use the `code-review-thorough` skill — broader coverage, includes style, naming, edge cases
   - The review subagent should read the full `git diff HEAD~1` (or `git diff <commit-before-your-changes>`) and assess every changed file
3. **Act on the review results**:
   - If **CRITICAL or MAJOR** issues found: fix them, commit, and re-run the review
   - If **only MINOR or no issues**: proceed to close the issue
4. **Update the board** — after review passes:
   ```
   update_issue(issueId, statusName="Done")
   ```

#### What the review subagent should check
- Correctness bugs and logic errors
- Security vulnerabilities (injection, XSS, etc.)
- Missing error handling
- Dead code or forgotten debug output
- Broken existing patterns or regressions
- That the commit actually addresses the ticket's requirements (all checklist items, not just some)

#### Complete the ticket's checklist
If the ticket description lists remaining steps, complete ALL of them before the review. Do not ask the user for permission to skip steps listed in the ticket. If a step is genuinely blocked, note it in the issue description — but do not commit partial work and mark Done.

### 7. Close the issue
After review approval:
```
update_issue(issueId, statusName="Done")
```
Do this only after the work is actually complete (tests pass, code committed, review passed). Do **not** mark Done while work is still in progress.

### 8. Cancel if work is abandoned
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
2. **Every commit gets reviewed** — branched workspaces get auto-reviewed by the system. Direct workspaces get reviewed by a subagent you spawn. No workspace skips review.
3. **Board reflects reality** — move to In Review while the review runs, move to Done only after review passes. Never skip In Review for direct workspaces.
4. **Complete the full ticket** — if the ticket lists steps, do all of them. Do not ask the user for permission to skip checklist items. If blocked, note it in the description and stop — don't mark Done.
5. **Commit before review** — never trigger review with uncommitted changes.
6. **One status transition per logical checkpoint** — don't batch-move issues after the fact.
7. **Description is a shared log** — write progress notes so the user can follow along without reading code.
8. **Done means done** — code committed, tests green, review passed, no loose ends, no open questions.
9. **Cancelled is not failure** — use it freely when scope changes.
10. **Targeted tests for refactoring** — vitest v4 uses a subcommand, not a flag. Run `cd packages/server && node node_modules/vitest/vitest.mjs related <source-files>` instead of the full suite when refactoring. It's faster and proves the changed code is covered without re-running unrelated tests.
