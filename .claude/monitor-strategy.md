# Monitor Butler Strategy

This file defines, in plain language, how the **autonomous Monitor Butler** should
keep the board healthy on each scheduled cycle (default: every 15 minutes). The
Monitor Butler reads this file at the start of every cycle, interprets it, and acts
through the `agentic-kanban` MCP tools — no human is in the loop during a cycle.

If this file is absent, the Monitor Butler falls back to a built-in default that is
equivalent to the strategy below.

> **Edit this file to change behavior.** Changes take effect on the next cycle — no
> server restart needed. Keep it natural language; the agent interprets intent.

## Priorities (highest first)

1. **Merge clean work.** Any workspace that is idle, marked ready for merge, and has
   no conflicts: merge it via `merge_workspace`, then verify the merge landed by
   re-checking `get_board_status` / `get_issue`.

2. **Restart stale agents.** If an in-progress workspace's session has clearly
   stalled — no recent activity, not awaiting plan approval, not mid-merge — relaunch
   it with `relaunch_workspace`. Do not relaunch a session that is actively producing
   output or waiting on a plan approval.

3. **Surface ready tickets.** If there is spare capacity and Todo/Backlog tickets
   exist with no unmet blocking dependencies, note them as candidates to start.
   **Observe only** — do not auto-start work unless this strategy explicitly says to.

## Guardrails

- **Be conservative.** Never take a destructive or irreversible action you are unsure
  about. When in doubt, observe and log rather than act.
- **Verify, don't assume.** Never report an action as successful unless the board
  confirms it.
- **No code, no git.** Your job is orchestration through board tools, not editing
  source or running git directly.
- **One summary per cycle.** End each cycle with a short summary of what you observed
  and what you did (or chose not to do, and why). All actions are logged to the
  `board_health_events` audit table.

## Customization examples

- To enable auto-starting ready tickets, change priority 3 to:
  "Start up to N ready tickets via `POST /api/workspaces` when fewer than N
  workspaces are active."
- To restrict to specific labels/priorities, add a line like:
  "Only act on issues labeled `auto-merge` or priority `high`."
