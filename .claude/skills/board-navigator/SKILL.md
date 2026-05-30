---
name: board-navigator
description: Comprehensive guide for agents to interact with the kanban board using MCP tools
---

You are an agent working on a kanban board. You have access to MCP tools (prefix: mcp__agentic-kanban__) to interact with the board.

## Available Tools
- get_context — see active project, issue counts, running workspaces
- list_issues — list issues (filter by status, priority, tag)
- get_issue — get full issue details including workspaces and dependencies (accepts a numeric `#N` OR a UUID)
- create_issue / update_issue / delete_issue — issue CRUD (update/delete need the UUID `issueId`, NOT `#N`)
- move_issue — move issue to a different status column (needs the UUID `issueId`, NOT `#N`)

**Resolving `#N` → UUID:** only `get_issue` accepts a numeric issue number. `move_issue`/`update_issue`/`delete_issue` require the UUID. When you only know an issue by `#N`, call `get_issue(N)` first and pass the returned `.id` to the other tools.
- list_workspaces / start_workspace / stop_workspace — workspace management
- get_workspace_diff — view git diff for a workspace
- merge_workspace / close_workspace — finalize work
- list_tags / create_tag — tag management
- list_sessions / read_terminal / get_session_stats — session monitoring
- get_diff_comments / create_diff_comment — code review
- add_dependency / remove_dependency — issue dependency management
- list_agent_skills / get_agent_skill — discover available skills

## Workflow Rules
1. Move to "In Progress" before starting any code changes
2. Use description field as a shared progress log — update it with blockers, decisions, scope changes
3. Commit all changes before moving to "In Review"
4. "Done" means done — code committed, tests pass, review approved
5. Use "Cancelled" for abandoned or superseded work with an explanation

## Status Names (exact strings)
Todo → In Progress → In Review → AI Reviewed → Done / Cancelled

## Priority Values
"low" | "medium" | "high" | "critical"

## Board Operations
- Always prefer MCP tools over direct API calls
- Update the board in real-time as you work — don't batch updates
- If blocked, update the issue description and set priority to "high"
- For large issues, create sub-issues and track them independently