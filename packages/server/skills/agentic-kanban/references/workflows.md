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

The one call that actually starts work is **`POST /api/workspaces`** — it creates the worktree,
moves the issue to In Progress and launches the agent, in one step. CLI: `workspace start <issue-id>`
(the UUID, which `issue get <N>` prints — this verb takes the id, not `#N`).

```
POST /api/workspaces { issueId }          # worktree + In Progress + agent, one call
get_board_status                          # watch it: session state, tokens, cost, last output
read_terminal { workspaceId }             # the agent's actual output
send_workspace_message { workspaceId, content }   # follow-up turn (409 while busy)
```

**`start_workspace` is NOT this call.** It creates a bare worktree record: no agent, no status
change. Reach for it only when you explicitly want an empty worktree. `launch_workspace` then
starts an agent in one that already exists.

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

This is how you hand an existing backlog — a repo's `BACKLOG.md`, a TODO list, a plan a human
wrote — to the board in one call. The board server must be running; import and export are HTTP
endpoints, not local DB writes.

```
import_backlog_markdown   { projectId, markdown, apply: false }   # preview: counts + warnings
import_backlog_markdown   { projectId, markdown, apply: true }    # write
export_backlog_markdown   { projectId, status?: "open" }          # the other direction
```

CLI equivalent: `agentic-kanban backlog import BACKLOG.md` (preview) / `--apply`, and
`backlog export --out BACKLOG.md [--status Todo]`.

**Import never deletes.** The default `update` mode matches each parsed issue to an existing one
— by `#N` (only when the file's `project` matches the target project), then by external `key`,
then by title — writes only the fields the file actually contains, ADDS tags and dependencies
rather than replacing them, and creates whatever did not match. Re-importing an unchanged export
is a no-op. **Always preview first**: the preview reports a `confidence` score and warnings, and
below ~0.6 you should fix the file rather than import it.

### The format (`kanban-md 1`) — enough to write one

```markdown
---
kanban-md: 1
project: pantry
statuses: Backlog, In Progress, In Review, Done
---

# pantry — backlog

## Backlog

### #12 Collapse the client's provider ladders
`priority: high` · `type: chore` · `tags: arch, client` · `depends: #10, #11` · `key: gh-77`

Why: nine hand-rolled copies drift.

- [ ] write the table
- [ ] delete the copies

## In Progress

### Ship it
`priority: medium` · `type: feature`
```

- Front matter is optional; `project` is what makes `#N` match existing issues on re-import.
- `## Section` is a **status column**, matched case-insensitively and through aliases
  (`Todo`/`To Do`/`Open` → Backlog, `Doing`/`WIP` → In Progress, `Closed`/`Completed` → Done).
  An unknown section becomes a new column.
- `### [#N] Title` is one issue. **Keep `#N` for issues that already exist; omit it for new ones**
  — numbers are assigned, and a colliding number is renumbered rather than overwriting.
- The backtick line right under the heading is metadata: `` `key: value` `` tokens joined by ` · `.
  Keys: `priority` (critical/high/medium/low), `type` (feature/bug/task/chore/epic), `tags`,
  `milestone`, `estimate`, `due`, `depends`, `blocks`, `key` (external id), `url`. All optional.
- Everything until the next `###`/`##` is the description. **Headings inside a description must be
  `####` or deeper** — a `##` or `###` there would be read as a new section or issue.
- `- [ ]` / `- [x]` lines in the body are the issue's checklist.

The importer also reads the styles people already write, so a plain `BACKLOG.md` usually imports
as-is: `## Todo` plus `- [ ]` items (each top-level item is an issue, sub-bullets are its
description), `- **Title** — description`, `#12` anywhere in a title, inline `[bug]` / `[P1]`
hints. Code fences are opaque. When you are converting a messy file, write the standard form
above rather than hoping — you can see exactly what was understood in the preview.

**Coupled tickets:** declare `depends:` / `blocks:` in the file rather than writing "do this with
#12" in prose. A `coupled_with` edge is what lets the board run several tickets as ONE workspace
with one review and one merge gate; prose is invisible to it.

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
