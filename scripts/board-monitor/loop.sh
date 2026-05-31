#!/usr/bin/env bash
# Detached board-monitor loop for agentic-kanban.
#
# Each iteration starts a FRESH `codex exec` session with the board-monitor
# objective (no resume — the board + git are the durable state, so a fresh
# session avoids context bloat and can't hijack a board workspace agent's
# session via `resume --last`). Hooks run (--dangerously-bypass-hook-trust) so
# the PreToolUse safety guards AND the Stop commit-discipline guard fire.
#
# Launch detached (no window, survives shell exit):
#   nohup bash scripts/board-monitor/loop.sh > /dev/null 2>&1 & disown
# Stop gracefully: `touch scripts/board-monitor/STOP` (exits after the current
# iteration) or kill the logged PID.
#
# Env knobs: MONITOR_SLEEP (default 300s between runs), MONITOR_MAX_ITERS
# (default 500), MONITOR_ITER_TIMEOUT (default 1800s per iteration).

set -u
REPO="C:/andrena/agentic-kanban"
DIR="$REPO/scripts/board-monitor"
LOG="$DIR/loop.log"
STOP="$DIR/STOP"
OBJ="$(cat "$DIR/objective.md")"
SLEEP="${MONITOR_SLEEP:-300}"
MAX="${MONITOR_MAX_ITERS:-500}"
ITER_TIMEOUT="${MONITOR_ITER_TIMEOUT:-1800}"

ts() { date -Iseconds; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

# Clear any stale STOP from a previous run.
rm -f "$STOP"
log "board-monitor loop START (pid $$, sleep ${SLEEP}s, max ${MAX}, iter-timeout ${ITER_TIMEOUT}s)"

short_streak=0
for (( i=1; i<=MAX; i++ )); do
  if [ -f "$STOP" ]; then log "STOP file present — exiting before iteration $i"; rm -f "$STOP"; break; fi

  log "--- iteration $i START ---"
  start=$(date +%s)
  timeout "$ITER_TIMEOUT" codex exec \
    --dangerously-bypass-approvals-and-sandbox \
    --dangerously-bypass-hook-trust \
    -C "$REPO" \
    "$OBJ" >> "$LOG" 2>&1
  code=$?
  dur=$(( $(date +%s) - start ))
  log "--- iteration $i END exit=$code dur=${dur}s ---"

  # Launch-failure guard (the 2026-05-31 learning): repeated instant exits mean
  # the launch is broken (bad flag, auth, etc.) — stop hammering and bail.
  if [ "$dur" -lt 8 ]; then
    short_streak=$(( short_streak + 1 ))
    if [ "$short_streak" -ge 3 ]; then
      log "3 consecutive instant exits (<8s) — launch likely broken; stopping loop. Inspect $LOG."
      break
    fi
  else
    short_streak=0
  fi

  if [ -f "$STOP" ]; then log "STOP file present — exiting after iteration $i"; rm -f "$STOP"; break; fi
  sleep "$SLEEP"
done

log "board-monitor loop END"
