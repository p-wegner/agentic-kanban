# Decision 006: Board-Monitor Orchestrator Architecture

## Date: 2026-05-31

## Context
The board needs an autonomous **orchestrator** ("board monitor") that keeps it moving without a
human in the loop: keep the dev server alive, land finished work (merge idle *In Review*
workspaces), unstick stale/failed agent sessions, pull backlog into progress (bounded WIP), and
refill the backlog before it hits zero.

Because **we develop agentic-kanban *using* agentic-kanban** (dogfooding), the orchestrator
operates on the same repo, DB, and server it is supervising. That makes resilience — not raw
capability — the dominant design constraint. We tried three approaches and have transcript
telemetry for all three from a single day (2026-05-31).

### The three approaches (measured)

| | A — Long-running goal thread | B — Independent short processes | C — App built-in monitor |
|---|---|---|---|
| Shape | One `codex` session held open on a `/goal` thread (goal-completion judge re-checks before the turn may end) | Fresh `codex exec` every ~5 min (`loop.sh`), no memory of prior runs; board+git are durable state | `runMonitorCycle` in-process in the server (`server-start.ts`) |
| Activity | 332 actions / 854 shell cmds in 8h40m | 48 iterations, ~1 action each | event-driven |
| Cost/action | **Rising**: per-call window 28K→~200K tokens; cumulative 77.4M in (98.4% cached) | **Flat**: ~62K tokens/run (32K–160K); ~0.6M effective for 7h vs A's ~8.8M | cheapest (no extra LLM) |
| Failure mode | **Died mid-tool-call**, no clean exit; board silently unsupervised ~1h. Single point of failure — one poisoned context taints every later turn | Iteration death is a non-event; next fires in 5 min. 3 runs hit the 30-min cap babysitting a merge; cap+respawn absorbed it | **Dies with the thing it watches**: a board-code hot-reload, merge error, `shared` rebuild, or schema-add crash kills it (see the schema-merge pitfall). Self-dogfooding fragility |
| Memory | Full (but unbounded → the cost/death problem) | None by default (its only real weakness) | in-process |

## Decision
**Run the orchestrator as approach B: independent, short-lived `codex exec` processes on a fixed
cadence, with external bounded memory.** Implementation lives in `scripts/board-monitor/`
(`loop.sh` + `objective.md` + a gitignored `state.md`). See that directory's `README.md` for
operations.

To close B's one weakness (amnesia) **without** reintroducing A's unbounded-context problem, each
fresh run reads a **bounded rolling-memory file** (`state.md`, last ~40 lines, trimmed
deterministically by the loop driver, gitignored so it never dirties the tree). The run uses that
history to **escalate rather than repeat** (e.g. nudged twice already → stop the stale session and
inspect the branch) and appends exactly one line summarizing the cycle.

## Rationale
1. **For a control loop that mutates the system it runs on, resilience beats awareness.** B's
   disposable runs cannot bloat, cannot be poisoned, and self-heal on crash — the properties that
   matter when the supervised system (our board) is being actively broken and rebuilt.
2. **Flat cost.** B's per-run cost is constant; A's marginal cost climbs every turn until it
   becomes unwieldy. Caching hides — but does not remove — A's growth.
3. **Externalize state, keep agents disposable.** The durable memory is the board, git, and a
   *bounded* `state.md` — not a model's context window. This restores cross-cycle continuity while
   every individual session stays small and throwaway.
4. **A completion judge is orthogonal.** `/goal`'s judge prevents *premature quitting*; it does
   nothing for context growth or process death. A clever turn-level guard must not be allowed to
   vouch for the architecture.
5. **Don't run the supervisor in-process with its subject.** C is cheapest but structurally
   fragile *for us* precisely because the board is both the tool and the subject; that's why
   `auto_monitor` is off for this repo.

## Consequences
- **This is our dev-board choice, not the app's default.** Approach C (the in-process monitor) ships
  in the app and is the right default for *other* projects developed with agentic-kanban — they are
  not modifying the board's own source, so C's blast radius doesn't apply. B is the dogfooding
  control plane for *this* repo.
- **The loop must survive its own hooks.** It runs with hooks enabled
  (`--dangerously-bypass-hook-trust`) so the PreToolUse safety guards and the Stop commit-discipline
  guard fire. The orchestrator **must commit any main-checkout fix immediately** — uncommitted
  changes block the auto-merge queue and can be lost (see
  `docs/learnings/2026-05-31-monitor-harness-requires-stop-hooks.md`).
- **Observability is now a first-class need.** Because B is many short, headless processes rather
  than one watchable session, we need to surface what it's doing — hence `state.md` (machine- and
  human-readable cycle log) and a planned lightweight board-side readout (and optional
  notifications). Without that, "is the orchestrator alive and making progress?" is invisible.
- **The `board-monitor` *skill*** (`.claude/skills/board-monitor/`) remains the **system-level
  health-check** playbook (conflict scan, server/frontend health) that a run invokes — it is the
  checklist, not the loop. The loop is `scripts/board-monitor/`.

## Status
Accepted and live (loop driver running on the 5-min cadence with `state.md` memory). Board-side
observability and optional user notifications are follow-ups (see the README's "Observability roadmap").
