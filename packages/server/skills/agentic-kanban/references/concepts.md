# Concepts

Load this when a board term in `SKILL.md` needs unpacking. Everything here is behaviour, not UI trivia.

## Workspace = worktree + agent

`POST /api/workspaces` (MCP `start_workspace`) does four things atomically: creates the DB record,
creates a git worktree on `feature/ak-<issue>-<slug>` off the project's base branch, materializes the
project's agent skills and ticket context into it, and launches the agent. There is no separate
"start the agent" step.

- The ticket context is written to `CLAUDE.local.md` **in the worktree** — ticket text, stack profile,
  sibling repos, service stack, board-feedback routing. It is **regenerated on every workspace
  creation**, so anything hand-written there is lost. In a *main checkout* the same filename means
  something else entirely (per-machine human config) — do not confuse them.
- Follow-up turn: `send_workspace_message` / `POST /:id/turn`. Returns 409 while the agent is busy.
- `DELETE` cascades sessions and messages. Deleting the workspace does not delete the branch.

## Statuses and transitions

Defaults: `Backlog`, `Todo`, `In Progress`, `In Review`, `AI Reviewed`, `Done`, `Cancelled`.
Projects may define custom statuses (`delete_status`, project settings), so read them rather than
assuming. `Cancelled` is for abandoned or superseded work and always wants a reason in the description.

## The pre-merge gate

Before a merge lands, the board runs the project's `verify_script` plus a boot/render smoke check.
The test half can be **scoped** to the packages a diff actually touches, but a scoped run always also
forces the *guard* suites — those that assert a property of the whole repo tree and would be invisible
to import-graph scoping.

`verify_gate_strategy_<projectId>` picks the tier (`full` | `scoped` | `scoped-base-watch` | `impact`).
A tier may only weaken verification **visibly**: a passing gate names what ran, e.g.
`pre-merge gate passed (tier: file-scoped, 3 changed file(s), +14 guard suites)`.

`impact` is the narrowest tier and is **strictly opt-in** — it is nobody's default and no risk posture
yields it. It picks the suites with the test-impact selection (a ranked heuristic) instead of
`vitest related`'s import-graph walk, plus the guard suites and every test file the diff touches.
Because what it drops is a guess rather than a provable non-dependency, its pass message additionally
names how many suites the selection kept, how many it dropped below the score floor, and whether the
impact map was fresh — a selection from a stale map is a weaker claim and must not read the same.

If the gate is red, the branch is wrong. Fix it, or run fix-and-merge (which rebases and re-runs) —
merging around it is never the answer.

## Review

`review_workspace` runs the project's `code-review` agent skill against the branch diff and writes
inline `diff_comments`. A project may override the built-in review prompt with a project-scoped skill
of the same name. `code-review-thorough` is the deeper, more expensive variant.

Read comments back with `get_diff_comments`; add your own with `create_diff_comment`. A review does not
move the card — `AI Reviewed` is a separate `move_issue`.

## Start Mode — how a project's tickets get started

One per-project setting, `start_mode_<projectId>`, is consulted by **every** auto-start path
(monitor scheduling, per-cycle relaunch/merge, the post-merge dependency cascade, backlog refill,
scheduled crons):

| Mode | Behaviour |
|---|---|
| `manual` | Nothing auto-starts. A true kill switch, including the post-merge cascade. |
| `monitor` | The in-process engine starts unblocked backlog up to the WIP limit, auto-reviews and auto-merges. **This is the supported hands-off driver.** |
| `conductor` | An out-of-process loop is the sole driver; the in-process engine stands down. |

Tag an issue `no-auto-start` to exempt it. Per-project Start Mode supersedes any global toggle.

## Agent roles — distinct mechanisms, do not conflate

| Name | Role |
|---|---|
| **Builder** | Per-ticket implementer inside a worktree. The common case. |
| **Autopilot** | In-process deterministic monitor (`runMonitorCycle`) — the `monitor` Start Mode. |
| **Conductor** | Out-of-process orchestrator driving a project from an objective file, fresh session per cycle. |
| **Steward** | In-process LLM monitor; off by default. |
| **Butler** | Warm conversational per-project assistant; one live session per project. |

## Ticket groups

N coupled tickets share **one** workspace, one agent, one review, one merge-gate run — while each
ticket keeps its own identity and closes when the branch lands. The signal is a `coupled_with`
dependency edge, declared at creation (`create_issues_batch`) rather than written as "do together
with #X" in prose. `propose_ticket_groups` consolidates an already-granular backlog (preview first).

Sizing rule for new tickets: a ticket should be **gate-sized**. A few-minutes change is not its own
ticket — it is a group member, or part of its neighbour.

## Agent skills

Prompt templates stored per board and materialized as `.claude/skills/<name>/SKILL.md` into each
worktree at creation time (`.codex/skills` is linked to the same directory). Built-in skills ship with
the package; project-specific ones live on disk in the project. `install-skill` writes them into a
project or into your user agent-skill directories — see `cli.md`.

## Worker fleet — agents on other machines

Workers dial the board over a WebSocket, clone the repo through the board's token-authed git smart
HTTP, work in their own checkout, and push to `refs/kanban/incoming/<branch>`; the board
**fast-forwards only** — divergence is held and reported, never forced. Only *placement* moves;
broadcast, persistence and exit classification are unchanged.

**Credentials never leave their machine.** A worker authenticates its own agent with its own local
login; the board sends none. Opt in per project (`worker_dispatch_<projectId>`), require capabilities
with labels, and use strict mode to forbid the host fallback.

Never expose the board API itself on a public interface — it has no auth. Expose only the dedicated
fleet and git-transport ports, which are bearer-token authed.

## Plugins

A plugin is a repo with a `kanban-plugin.json` manifest contributing skills, iframe views, one-shot
scripts, **loops**, a butler prompt fragment, and a scaffold template. Install once, enable per project.

A **loop** is board-owned converging analysis: the plugin contributes only a deterministic `plan`
command printing outstanding work units as JSON; the board turns each unit into a ticket, and the
monitor runs them within the project's WIP limit. Loop state *is* the tickets, so it survives a
restart. Two traps: unit ids are the contract (a re-pass needs a *fresh* id), and `converged: true`
is a claim about the whole job — a loop merely blocked on upstream work reports
`units: [], converged: false`.
