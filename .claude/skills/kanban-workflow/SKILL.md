---
name: kanban-workflow
description: Guide for using the agentic-kanban MCP tools to reflect implementation progress on the board. Use when starting work on an issue, moving through implementation steps, reviewing completed work, or closing out a task.
argument-hint: [issue-id or issue-number]
---

# Kanban Workflow — Reflecting Implementation Steps on the Board

Use the **agentic-kanban MCP** tools (prefix `mcp__agentic-kanban__`) to keep the board in sync with your actual work.

## Tool selection

Builder sessions should use the harness-native file inspection tools where available: Claude `Read` for file contents and `Grep` for content search; Codex `rg`/shell inspection is acceptable when those tools are not available. Avoid fragile PowerShell text pipelines for review/search work (`git show HEAD:file | Select-String` fails with German-locale quoting errors); prefer searching a real file path with the harness-native search tool.

## Available MCP Tools

| Tool | Purpose |
|------|---------|
| `get_context` | Active project, issue counts by status, active workspaces |
| `get_board_status` | Full dashboard: issues with workspace state, diff/session stats, last output |
| `list_issues` / `get_issue` | List (filter by status/priority/tag) / full detail (workspaces + dependencies) |
| `create_issue` / `update_issue` / `delete_issue` / `move_issue` | Create / change status·title·desc·priority / delete / move (shorthand) |
| `list_workspaces` / `start_workspace` / `stop_workspace` | List (filter by issue) / create worktree workspace / stop a session |
| `merge_workspace` / `get_workspace_diff` | Merge branch + close / get git diff |
| `list_tags` / `create_tag` | Tag management |
| `list_sessions` / `read_terminal` / `get_session_stats` | Session list / last N terminal lines / token·cost·duration |

## Workflow

### 1. Orient
`get_context` (active project, open issues, running workspaces) → `list_issues` (filter `statusName="Todo"`) → `get_issue(issueId)` (title, description, status).

### 2. Start work — move first, code second
```
update_issue(issueId, statusName="In Progress")
```
**Hard rule:** never start coding without moving the issue first — it gives the user live board feedback.

### 3. Break down (optional)
Large issue → `create_issue(title="Step 1: …", priority="medium")` per step; move each to In Progress on start, Done on finish.

### 4. Log progress in the description
The description is the **only shared state** between you and the user — log blockers, decisions, scope changes:
```
update_issue(issueId, description="## Progress\n- Schema migrated\n- API route WIP\n- UI pending")
```

**Direct workspaces (`isDirect: true`)** work straight on the default branch (no feature branch to merge). You must still move the issue status when done, and the system does NOT auto-review them — run a self-review subagent before committing (Step 6).

### 5. Test and commit (mandatory before finishing)
1. **Run tests.** For refactors, run only tests for changed files. vitest v4 moved `--related` to a subcommand — the flag no longer works:
   ```bash
   cd packages/server && node node_modules/vitest/vitest.mjs related src/services/foo.service.ts
   # or derive from git:
   cd packages/server && node node_modules/vitest/vitest.mjs related $(git diff --name-only HEAD | grep "^packages/server" | sed 's|packages/server/||')
   pnpm test:mine   # fast iteration, safe subset, no known-flaky
   ```
   If `pnpm test:mine` fails with "could not find vitest", check whether `node_modules` is a junction: `(Get-Item node_modules).LinkType`. If it returns `Junction` → do NOT install (deps are shared). If it returns nothing or `Directory` → the worktree predates symlinks; run `pnpm install` once to create local deps.
   Full suite (`pnpm --filter agentic-kanban test`) only for cross-cutting changes or a final pre-commit check.
2. Stage and commit all changed files with a message summarizing what + why; reference the issue if appropriate.

**Commit the moment the core is green** — the instant `tsc -b --noEmit` passes for the packages you touched AND directly-related tests pass, commit. Continue polish/extra tests in follow-up commits. Don't batch a multi-step diff into one end-of-task commit — an interruption (crash, hot-reload, timeout) loses all of it. Never leave the worktree with uncommitted changes.

### 6. Review (every workspace, no exceptions)

**Branched workspaces — automatic.** After your session exits, the system launches a review subagent (purple **AI Reviewing** badge) and handles the full review→fix→merge cycle. Do nothing — just commit, run tests, exit normally. **Do NOT call any REST endpoint to trigger it** — there is no `/propose-transition` or `/review-trigger`; the transition fires on session exit.

> Visual verification: if the project has `visual_verification_mode = "after_merge"`, you need NOT verify the UI before stopping — the server tags `needs-visual-verification` at merge time on client file changes. If `"before_merge"` (default), the stop hook blocks you until you run `/playwright-cli` and confirm the UI renders.

**Direct workspaces — you must trigger it** before marking Done:
1. `update_issue(issueId, statusName="In Review")`.
2. Spawn a review subagent (Codex `spawn_agent` / Claude `Agent` tool). Pass the diff context (changed files, commit message, issue description). Respect review settings: `thorough_review` unset/`false` → `code-review` skill (correctness, security, logic); `true` → `code-review-thorough` (broader, includes style/naming/edge cases). The subagent reads the full `git diff HEAD~1` and assesses every changed file.
3. CRITICAL/MAJOR found → fix, commit, re-review. Only MINOR / none → close.
4. `update_issue(issueId, statusName="Done")`.

**Review checklist (what the subagent checks):** correctness/logic bugs; security (injection, XSS); missing error handling; dead code / debug output; broken patterns or regressions; that the commit addresses ALL the ticket's checklist items, not just some.

**Complete the full ticket:** if the description lists steps, do ALL of them before review — don't ask permission to skip listed steps. A genuinely-blocked step → note it in the description; never commit partial work and mark Done.

### 7. Close
`update_issue(issueId, statusName="Done")` — only after work is actually complete (tests pass, committed, review passed). Never mark Done with work in progress.

### 8. Cancel if abandoned
`update_issue(issueId, statusName="Cancelled")` for superseded/irrelevant issues; add a note in the description explaining why. Cancelled is not failure — use it freely when scope changes.

## Reference

**Status names** (exact strings for `statusName`): `"Todo"` · `"In Progress"` · `"In Review"` (impl complete, awaiting review) · `"AI Reviewed"` (passed auto-review, ready to merge) · `"Done"` · `"Cancelled"`.

**Priority** (for `priority`): `"low"` | `"medium"` | `"high"` | `"critical"`.

## "Review #N" / "Merge #N"

When the user says "review #N", "review #N and merge", or "merge #N", this is **board issue #N, never a GitHub PR** (this project uses manual merge, no PRs). Workflow:
1. Find the issue by `issueNumber` (`get_board_status` / `list_issues`).
2. Find its workspace (board data, or `list_workspaces` with the issue ID).
3. `get_workspace_diff(workspaceId)` → review all changes for correctness, security, broken patterns, missing cleanup.
4. **Fine** → merge (`POST /api/workspaces/:id/merge` or `merge_workspace`) → `update_issue(issueId, statusName="Done")`.
5. **Not fine** → report issues to the user, leave the issue in its current status.

## Rules of thumb

- **Board reflects reality** — In Progress before edits; In Review while review runs; Done only after review passes. Never skip In Review for direct workspaces.
- **One status transition per logical checkpoint** — don't batch-move issues after the fact.
- **Done means done** — committed, tests green, review passed, no loose ends or open questions.
