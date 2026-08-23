---
name: agentic-kanban
description: Operate the agentic-kanban board — a kanban board where each card is an AI coding session in its own git worktree. Use when asked to work a ticket, drive a project hands-off, review or merge agent work, inspect what agents are doing, or wire the board into another tool. Covers the MCP tools, CLI, board views, statuses, and the review/merge gate.
commit: 0eb243cdd9
generated: 2026-08-23
---

# agentic-kanban

A local-first kanban board for AI-driven coding. **Every card is a coding session**: moving an
issue into work creates a *workspace* — a git worktree on `feature/ak-<issue-number>-<slug>` with an
agent (Claude Code / Codex / Copilot / Pi) running inside it. The board owns the loop around that
agent: launch, stream output, diff, review, gate, merge, close.

You reach it three ways, in this order of preference:

1. **MCP** — `mcp__agentic-kanban__*`. Structured, no shell. Use this from an agent.
2. **CLI** — `agentic-kanban <cmd>` (in this repo: `pnpm cli -- <cmd>`). Use for scripting and setup.
3. **REST** — `http://127.0.0.1:3001/api/*`. Last resort; everything above is a thin wrapper on it.

Never hand-roll what the board already does (create a worktree, run a review, resolve a merge). If a
verb below exists, call it.

## Using the board from a project that is NOT the board's checkout

This skill is installed machine-wide, so you will usually meet the board from some *other*
repo — one that has no board source, no board database, and no idea the board exists. That is
the supported case. You never need to read the board's code to use it; everything you need is
in this skill and its `references/`.

**Preconditions, both on THIS machine:**

1. **The board server is running.** MCP tools and the CLI reach it on loopback
   `127.0.0.1:3001` (override with `KANBAN_SERVER_PORT`). Start it with `npx agentic-kanban dev`,
   or from a Docker install. Issue CRUD and project registration work without it, but backlog
   import/export, workspaces, review and merge do not.
2. **One database.** Every board process on the machine opens the same SQLite file — the board's
   own checkout uses `packages/server/kanban.db`, everything else `~/.agentic-kanban/kanban.db`;
   `AGENTIC_KANBAN_DIR` or `DB_URL` overrides both. If the board UI shows different data than
   your tools return, that is the split — check the `[db] opening …` line the CLI prints.

**Do you have the tools?** If your tool list contains `mcp__agentic-kanban__*`, you are wired —
use those. If it does not, either use the CLI (`npx -y agentic-kanban <command>`, same verbs, no
MCP needed) or ask the user to wire MCP once, machine-wide:

```bash
claude mcp add agentic-kanban --scope user -- npx -y -p agentic-kanban agentic-kanban-mcp
```

**The repo you are in must be a registered project** before it can hold tickets. Check with
`list_projects` (CLI: `npx -y agentic-kanban list`); register with `register_project` (CLI:
`npx -y agentic-kanban register .`). Registration detects the stack, derives the setup and verify
commands, **and scaffolds the repo**: `.claude/` safety hooks, a starter `CLAUDE.md`/`AGENTS.md`,
and `.gitignore` entries for agent artifacts — committed as `chore: scaffold agent guards and
onboarding`. That is a write and a commit in someone else's repository, so say what it will do
before you run it, and run it on a clean tree.

**Then pick the flow:**

| You were asked to | Do this |
|---|---|
| Put an existing backlog (a `BACKLOG.md`, a TODO list, a plan) on the board | Shape it into Backlog Markdown and `import_backlog_markdown` with `apply: false` first to preview, then `apply: true`. See `references/workflows.md`. |
| File one or a few tickets | `create_issue` — or `create_issues_batch` when they are related, declaring `coupled_with` for tickets that must land together. |
| Actually implement a ticket | `POST /api/workspaces` (CLI: `workspace start <issue-id>`) — the board makes the worktree, launches an agent in it and drives review/gate/merge. Do NOT clone, branch or edit the repo yourself to "help". |
| Say what is going on | `get_board_status` for the project, not an unbounded workspace dump. |

**Always pass `projectId` explicitly.** `create_issue` defaults to the board's *active* project,
which is whatever the user last looked at in the UI — almost never the repo you are sitting in.

## The core loop

```
register a repo  →  create issue  →  workspace (worktree + agent)  →  diff  →  review  →  gate  →  merge  →  Done
```

- **Statuses** (defaults; projects may define their own):
  `Backlog → Todo → In Progress → In Review → AI Reviewed → Done`, plus `Cancelled`.
- **Move the card as you work.** `In Progress` before the first edit, `In Review` only after the
  work is committed. The issue description doubles as the shared progress log — write blockers,
  decisions and scope changes into it rather than into chat.
- **"Done" means merged and verified**, not "the agent stopped".
- **`#N` is always a board issue number**, never a GitHub PR.

## What the board does for you

| Capability | Reach it with |
|---|---|
| Issues, sub-issues, tags, priorities, dependencies | `list_issues`, `get_issue`, `create_issue`, `move_issue`, `add_dependency` |
| Batch backlog creation, coupled ticket groups | `create_issues_batch`, `propose_ticket_groups` |
| Backlog as a single markdown file, both directions | `export_backlog_markdown` / `import_backlog_markdown` |
| Start work: worktree + In Progress + agent, in one call | `POST /api/workspaces` (CLI `workspace start`) — *not* `start_workspace`, which makes a bare worktree |
| Follow-up turns, resume, stop a running agent | `send_workspace_message`, `relaunch_workspace`, `stop_workspace` |
| Watch agents live (output, tokens, cost, stalls) | `get_board_status`, `read_terminal`, `get_session_stats` |
| AI code review with inline diff comments | `review_workspace`, `get_diff_comments`, `create_diff_comment` |
| Pre-merge gate (tests + boot/render smoke) then merge | `merge_workspace` |
| Risk digest, similar past failures, health | `get_board_risk_digest`, `find_similar_failures` |
| Hands-off driving of a whole project | Start Mode (`manual` / `monitor` / `conductor`) |
| Remote execution on other machines | Worker Fleet (`worker pair`, `worker start`) |
| Per-project prompt templates injected into worktrees | Agent Skills (`list_agent_skills`, `install-skill`) |
| Warm per-project assistant | Butler (`ask_butler`, `butler ask`, key `i` in the UI) |

Depth on any of these lives in `references/` — load a file only when you actually need it:

| File | When |
|---|---|
| `references/concepts.md` | Agent roles, Start Modes, the pre-merge gate, worker fleet, plugins, ticket groups |
| `references/workflows.md` | Step-by-step recipes: work a ticket, drive a project, unstick, review, merge |
| `references/mcp-tools.md` | Full MCP tool list with descriptions, by category |
| `references/cli.md` | Full CLI command list, by group |
| `references/views-and-shortcuts.md` | Board views and keyboard shortcuts |

<!-- GENERATED:mcp-index — do not edit; run `node packages/server/scripts/generate-bundled-skill.mjs` -->

## MCP tool index

111 tools, by category. Full descriptions: `references/mcp-tools.md`.

| Category | Tools |
|---|---|
| Board Overview | `get_context`, `get_board_status`, `get_board_risk_digest`, `find_similar_failures`, `delete_status` |
| Issues | `list_issues`, `get_issue`, `get_issue_summary`, `create_issue`, `create_sub_issue`, `create_issues_batch`, `update_issue`, `delete_issue`, `move_issue`, `attach_artifact`, `check_issue_overlap`, `analyze_touched_files`, `export_backlog_markdown`, `import_backlog_markdown` |
| Workspaces | `list_workspaces`, `start_workspace`, `launch_workspace`, `relaunch_workspace`, `wait_workspace`, `get_workspace_diff`, `get_workspace_scorecard`, `merge_workspace`, `close_workspace`, `mark_ready_for_merge`, `stop_workspace`, `delete_workspace`, `export_handoff_bundle` |
| Sessions | `list_sessions`, `recent_sessions`, `read_terminal`, `get_session_transcript`, `get_session_stats`, `search_sessions`, `analyze_session`, `get_fleet_friction`, `backfill_friction`, `session_history` |
| Tags | `list_tags`, `create_tag` |
| Code Review | `review_workspace`, `get_diff_comments`, `create_diff_comment`, `approve_tool_use`, `session_review_effectiveness`, `reviewer_fixes` |
| Dependencies | `add_dependency`, `remove_dependency`, `analyze_dependencies`, `update_dependencies_batch`, `contract_coupled_issues`, `propose_ticket_groups` |
| Workflow | `propose_transition`, `clarify_or_propose`, `list_workflow_templates`, `get_workflow_template`, `create_workflow_template`, `update_workflow_template`, `delete_workflow_template` |
| Agent Skills | `list_agent_skills`, `get_agent_skill`, `create_agent_skill`, `export_agent_skills`, `install_skill` |
| Living Specs | `openspec_list_specs`, `show_spec`, `validate_change` |
| Drives | `start_drive`, `list_drives`, `get_drive`, `finish_drive`, `drive_review_effectiveness` |
| Projects | `register_project`, `create_project`, `list_projects`, `unregister_project`, `cleanup_project`, `init_project`, `list_project_repos`, `add_project_repo`, `remove_project_repo` |
| Settings | `get_preference`, `set_preference` |
| Butler | `ask_butler`, `butler_ensure`, `butler_stop`, `butler_list`, `butler_interrupt`, `butler_state`, `butler_set_model`, `butler_set_profile`, `get_butler_skill`, `set_butler_skill` |
| Plugin Loops & Gates | `list_plugin_gates`, `get_plugin_gate`, `resolve_plugin_gate`, `advance_plugin_loop`, `list_inbox`, `enable_plugin`, `set_plugin_output_location`, `get_plugin_scaffold`, `fill_plugin_scaffold` |
| Worker Fleet | `list_workers`, `explain_worker_placement`, `mint_worker_pairing_token`, `revoke_worker`, `list_incoming_refs` |

<!-- /GENERATED:mcp-index -->

<!-- GENERATED:cli-index — do not edit; run `node packages/server/scripts/generate-bundled-skill.mjs` -->

## CLI index

`agentic-kanban <command>` (inside this repo: `pnpm cli -- <command>`). Full list with descriptions: `references/cli.md`.

Top-level: `cleanup`, `create`, `delete-status`, `dev`, `export-backlog`, `import-backlog`, `init`, `install-skill`, `list`, `register`, `status`, `unregister`

| Group | Subcommands |
|---|---|
| `backlog` | `export`, `import` |
| `board` | `risk-digest`, `context` |
| `butler` | `ask`, `ensure`, `stop`, `interrupt`, `model`, `profile`, `state`, `list` |
| `butler skill` | `get`, `set` |
| `drive` | `start`, `list`, `get`, `finish`, `review-effectiveness` |
| `issue` | `list`, `get`, `create`, `update`, `move`, `status`, `summary`, `create-sub`, `delete`, `attach-artifact`, `create-batch`, `check-overlap` |
| `issue dependency` | `list`, `add`, `remove`, `analyze`, `update-batch` |
| `openspec` | `list`, `show`, `validate` |
| `preferences` | `set`, `get` |
| `services` | `reap` |
| `session` | `analyze`, `recent`, `backfill-friction`, `review-effectiveness`, `reviewer-fixes`, `transcript`, `search`, `stats`, `friction`, `find-similar` |
| `skill` | `list`, `get`, `create`, `export`, `verify` |
| `tag` | `list`, `create` |
| `worker` | `pair`, `start`, `instructions`, `list`, `explain`, `placements`, `doctor`, `doctor-board`, `events` |
| `workflow` | `list`, `get`, `export`, `create`, `import`, `delete` |
| `workspace` | `list`, `create`, `launch`, `resume`, `wait`, `review`, `start`, `diff`, `scorecard`, `merge`, `close`, `stop`, `delete`, `relaunch`, `mark-ready`, `propose-transition`, `clarify`, `analyze-touched`, `terminal`, `comment-list`, `comment-add`, `handoff-bundle`, `approve-tool` |

<!-- /GENERATED:cli-index -->

## Rules that save you a wasted cycle

- **Ask narrowly.** `get_board_status` or `list_issues` with a filter — not an unbounded
  `list_workspaces` dump. `list_issues` omits descriptions on purpose; use `get_issue` for one.
- **One workspace per issue.** If one exists, resume it (`workspace resume <N>`) instead of making
  a second worktree on the same branch.
- **Commit before `In Review`.** The diff, the review and the gate all read committed state; an
  uncommitted worktree reviews as empty.
- **Let the gate fail.** A red pre-merge gate is the answer, not an obstacle — fix the branch, or
  use fix-and-merge, but never merge around it.
- **File board feedback against the right project.** `create_issue` defaults to the *active*
  project, which is usually not the one you mean. Pass `projectId` explicitly.
- **Blocked is not done.** If you cannot finish, leave the card `In Progress` with the blocker in
  the description. Silently parking work in `In Review` strands it.
