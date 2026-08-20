# Workflows

Recipes. MCP tool names are given bare (`get_issue`); the real name is
`mcp__agentic-kanban__get_issue`. CLI equivalents assume `agentic-kanban` on PATH.

## Work a ticket you were handed

```
get_issue { issueNumber: N }              # full text, dependencies, existing workspaces
move_issue { issueNumber: N, status: "In Progress" }
… implement, committing as you go …
update_issue                              # description = progress log: decisions, blockers, scope
move_issue { issueNumber: N, status: "In Review" }   # only once committed
```

If a workspace already exists for the issue, resume it rather than creating a second one.
If you are blocked, say so in the description and leave the card `In Progress` — do not park it in
`In Review`.

## Start work on a ticket from scratch

```
start_workspace { issueNumber: N }        # worktree + agent, one call
get_board_status                          # watch it: session state, tokens, cost, last output
read_terminal { workspaceId }             # the agent's actual output
send_workspace_message { workspaceId, content }   # follow-up turn (409 while busy)
```

## Review and merge

```
get_workspace_diff { workspaceId }        # vs the workspace's baseBranch
review_workspace { workspaceId }          # AI review → inline diff comments
get_diff_comments { workspaceId }
merge_workspace { workspaceId }           # runs the pre-merge gate, then merges
```

A red gate means the branch is wrong — fix it or use fix-and-merge. A stale branch (many commits
behind) usually wants a rebase (`update-base`) first; a branch reported "25 commits ahead" is very
often duplicates that collapse to one or two real commits under rebase.

## Drive a whole project hands-off

1. Register the repo, seed the backlog (`create_issues_batch`, or import a `BACKLOG.md`).
2. Declare `coupled_with` edges for tickets that must land together.
3. Set the project's **Start Mode** to `monitor` (Monitor view → Start Mode).
4. Watch with `get_board_status` / `get_board_risk_digest`; intervene only on stalls.

The monitor starts unblocked backlog up to the WIP limit, reviews, and merges. It will not start
issues tagged `no-auto-start`.

## Unstick a stalled workspace

```
get_session_stats { workspaceId }
read_terminal { workspaceId, lines: 200 }
```

Read the *shape* of the failure before acting:

| Symptom | Meaning | Do |
|---|---|---|
| ~1s runtime, zero tokens | launch failed | stop it, rebuild the branch |
| Running, no output for hours | stalled | stop, then relaunch |
| Agent asked a question and waited | needs input | answer via a follow-up turn |
| Red gate | branch is wrong | fix the branch, re-run the gate |

Recover **one** stale workspace at a time — at most two more once the first is healthy. Resuming a
dozen at once reliably makes things worse.

## Backlog as one markdown file

```
agentic-kanban backlog export --out BACKLOG.md [--status Todo]
agentic-kanban backlog import BACKLOG.md          # preview
agentic-kanban backlog import BACKLOG.md --apply
```

Import is liberal and never deletes; it matches by `#number` (same project only) and is idempotent.
Always preview before `--apply`.

## Find out what is going on right now

```
get_context             # active project, issue counts, running workspaces
get_board_status        # per-issue: workspace state, session, diff stats, tokens, cost, last output
get_board_risk_digest   # merge blockers, stale sessions, low backlog, top 3 actionable items
```

`get_board_status` is the single best answer to "what are my agents doing?". Reach for
`list_workspaces` only when you genuinely need every workspace.

## Report a flaw in the board itself

Route by where you are:

- **A checkout of the board** — fix it, and file a ticket against the *board's* project for
  traceability (pass `projectId` explicitly).
- **A worktree, or someone else's project** — file a ticket against the board's project. Do not
  hand-edit the board's main checkout while other workspaces are live.
- **An npm/npx or docker install** — there is nothing to fix locally and no board backlog that will
  ever be actioned. File a GitHub issue instead.

Never silently drop the finding, and never abandon your own ticket over it.
