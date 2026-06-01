# Board-Monitor Orchestrator (`scripts/board-monitor/`)

The autonomous control plane that keeps **this** dev board moving: server alive, finished work
merged, stale sessions unstuck, backlog flowing and refilled. Architecture decision and the
A/B/C comparison that led here: [`docs/decisions/006-board-monitor-orchestrator-architecture.md`](../../docs/decisions/006-board-monitor-orchestrator-architecture.md).

**TL;DR of the approach:** a fresh, short-lived `codex exec` session every ~5 minutes (not one
long-running agent, not the in-process monitor). Each run makes the bounded set of high-value
control-plane actions its priorities call for (e.g. merge finished work, fill agent slots up to the
target) and exits. Durable memory lives outside the model — in the board, git, and a small rolling
`state.md` — so every session is disposable and crash-resilient.

**`objective.md` is the single source of truth for monitor policy.** Both this codex loop and the
in-process **Monitor Butler** (`packages/server/src/services/monitor-butler.ts`, off by default)
read this same file — its `STRATEGY_FILE` points here. There is no separate `.claude/monitor-strategy.md`.
Steer everything (priorities + the TUNABLE TARGETS block) by editing `objective.md`.

## Files

| File | Role | Committed? |
|---|---|---|
| `loop.sh` | The driver: fires `timeout 1800 codex exec "<objective>"` every `MONITOR_SLEEP`s (**re-reading `objective.md` each iteration**), trims `state.md`, has a launch-failure guard | yes |
| `objective.md` | The prompt each fresh run receives (read it to know what the orchestrator is told to do) | yes |
| `state.md` | **Rolling cross-iteration memory** — one line per cycle, newest last, trimmed to the last `MONITOR_STATE_KEEP` (40) lines. Runtime state, not source | **no** (gitignored) |
| `loop.log` | Full append-only transcript of every iteration's stdout/stderr | no (gitignored) |
| `loop.pid` | PID of the current driver | no (gitignored) |
| `STOP` | Sentinel: create it to stop the loop gracefully after the current iteration | no (gitignored) |

## Operate

```bash
# Start (detached, no window, survives shell exit):
nohup bash scripts/board-monitor/loop.sh > /dev/null 2>&1 & disown

# Stop gracefully (exits after the current iteration finishes):
touch scripts/board-monitor/STOP
# ...or, if it's only sleeping between iterations, kill the driver:
kill "$(cat scripts/board-monitor/loop.pid)"
```

> **`objective.md` is re-read at the start of every iteration** — edit it (including its TUNABLE
> TARGETS block: agent target, backlog floor, per-cycle start cap) and the **next cycle picks it up
> with no restart**. This is the single place to steer the loop's pace. Only `loop.sh`'s own env
> knobs (`MONITOR_SLEEP` etc.) are read once at start and still require a restart.

**Env knobs:** `MONITOR_SLEEP` (gap between runs, default 300s) · `MONITOR_MAX_ITERS` (default 500)
· `MONITOR_ITER_TIMEOUT` (per-iteration cap, default 1800s) · `MONITOR_STATE_KEEP` (memory lines
kept, default 40).

## Observe (current)

Everything is on disk; no service needed.

```bash
cd scripts/board-monitor

# Is it alive?
ps -p "$(cat loop.pid)" >/dev/null && echo ALIVE || echo DEAD

# What has it been deciding? (the human-readable memory)
cat state.md

# Per-iteration outcomes (exit code + duration; exit=124 means it hit the 30-min cap):
grep -aE "iteration [0-9]+ END" loop.log | tail -20

# Latest cycle's reasoning / actions:
tail -c 4000 loop.log | tr -d '\000'
```

What the signals mean:
- **`state.md` is the fastest read** — one line per cycle, says what was merged/started/nudged/stopped
  and how many consecutive cycles an item has been touched (so you can spot something it keeps
  re-acting on).
- **`exit=0`** = clean bounded run. **`exit=124`** = hit the iteration timeout (usually babysitting a
  long merge/rebase) — fine in ones and twos; a streak means something is stuck.
- **3 consecutive sub-8s exits** → `loop.sh`'s launch-failure guard stops the loop and logs why
  (bad flag / auth / broken launch). If the loop is gone and `loop.log` ends with that message,
  fix the launch before restarting.

## Observability roadmap (planned)

`state.md` + `loop.log` are the substrate. Because the orchestrator is many headless processes
rather than one watchable session, we want to surface it:

1. **Repo docs (done):** this README + ADR 006 record the approach so it isn't tribal knowledge.
2. **Board-side readout (planned):** expose the recent cycle summaries (from `state.md`) in the
   board's monitor UI — a lightweight "Orchestrator" strip showing last-cycle time, action,
   merged/started counts, and anything flagged. This is dogfood-only (gated/off for shipped
   installs that use the in-process monitor instead).
3. **Optional notifications (planned):** an opt-in systray / push nudge when the orchestrator does
   something noteworthy (merge landed, item flagged for a human, loop died) so the user gets
   feedback without watching the board.
