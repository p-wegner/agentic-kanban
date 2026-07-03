#!/usr/bin/env bash
# Detached board-monitor loop.
#
# Each iteration starts a FRESH agent session with the board-monitor objective
# (no resume — the board + git are the durable state, so a fresh session avoids
# context bloat and can't hijack a board workspace agent's session via
# `resume --last`). The repo's hooks fire either way, so the PreToolUse safety
# guards AND the Stop commit-discipline guard run every cycle.
#
# Which harness runs each cycle is chosen by MONITOR_AGENT (default "claude"):
#   - claude → Claude Code headless (`claude --print`, runs in $REPO, hooks native)
#   - codex  → `codex exec` (needs -C "$REPO" + --dangerously-bypass-hook-trust
#              so the Claude-style hooks fire through codex's bridge)
# Both read the SAME objective.md; only the launch command differs.
#
# Launch detached (no window, survives shell exit):
#   nohup bash scripts/board-monitor/loop.sh > /dev/null 2>&1 & disown
#   # drive a registered non-agentic-kanban project:
#   nohup bash scripts/board-monitor/loop.sh --project <id> --repo <path> --objective <path> > /dev/null 2>&1 & disown
#   # to run the codex harness instead of Claude Code:
#   MONITOR_AGENT=codex nohup bash scripts/board-monitor/loop.sh > /dev/null 2>&1 & disown
# Stop gracefully: `touch scripts/board-monitor/STOP` (exits after the current
# iteration) or kill the logged PID.
#
# Env knobs: MONITOR_AGENT (default "claude"; "codex" for the codex harness),
# MONITOR_SLEEP (default 900s = 15min between runs), MONITOR_MAX_ITERS
# (default 500), MONITOR_ITER_TIMEOUT (default 1800s per iteration).

set -u

PROJECT_ID="${MONITOR_PROJECT_ID:-agentic-kanban}"
# Default the repo to THIS checkout (loop.sh lives at <repo>/scripts/board-monitor/),
# derived from the script's own location so it is machine-independent. `pwd -W` yields a
# Windows-style path (C:/...) on Git Bash/MSYS — needed for codex -C and Windows tooling —
# and falls back to a POSIX path elsewhere. Override with MONITOR_REPO when driving another repo.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO="$(cd "$SCRIPT_DIR/../.." && { pwd -W 2>/dev/null || pwd; })"
REPO="${MONITOR_REPO:-$DEFAULT_REPO}"
OBJECTIVE="${MONITOR_OBJECTIVE:-}"
STATE_DIR="${MONITOR_STATE_DIR:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project)
      PROJECT_ID="${2:-}"; shift 2 ;;
    --repo)
      REPO="${2:-}"; shift 2 ;;
    --objective)
      OBJECTIVE="${2:-}"; shift 2 ;;
    --state-dir)
      STATE_DIR="${2:-}"; shift 2 ;;
    --agent)
      MONITOR_AGENT="${2:-}"; shift 2 ;;
    --sleep)
      MONITOR_SLEEP="${2:-}"; shift 2 ;;
    --)
      shift; break ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 64 ;;
  esac
done

if [ -z "$OBJECTIVE" ]; then
  OBJECTIVE="$REPO/scripts/board-monitor/objective.md"
fi
if [ -z "$STATE_DIR" ]; then
  if [ "$OBJECTIVE" = "$REPO/scripts/board-monitor/objective.md" ]; then
    STATE_DIR="$REPO/scripts/board-monitor"
  else
    STATE_DIR="$REPO/.kanban/conductor"
  fi
fi

DIR="$STATE_DIR"
LOG="$DIR/loop.log"
STOP="$DIR/STOP"
STATE="$DIR/state.md"
LOCK="$DIR/loop.lock"
AGENT="${MONITOR_AGENT:-codex}"
SLEEP="${MONITOR_SLEEP:-1800}"
MAX="${MONITOR_MAX_ITERS:-500}"
ITER_TIMEOUT="${MONITOR_ITER_TIMEOUT:-1800}"
# Rolling cross-iteration memory: each fresh session reads state.md for what
# recent cycles did (so it can ESCALATE instead of repeating), then appends one
# line. Bounded here (not by the LLM) to the last N lines so context stays flat.
STATE_KEEP="${MONITOR_STATE_KEEP:-40}"

ts() { date -Iseconds; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

mkdir -p "$DIR"

acquire_lock() {
  if mkdir "$LOCK" 2>/dev/null; then
    echo "$$" > "$LOCK/pid"
    return 0
  fi
  owner="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
    log "another conductor already owns project ${PROJECT_ID} (pid ${owner}); exiting"
    exit 2
  fi
  rm -rf "$LOCK"
  if mkdir "$LOCK" 2>/dev/null; then
    echo "$$" > "$LOCK/pid"
    return 0
  fi
  log "failed to acquire conductor lock for project ${PROJECT_ID}; exiting"
  exit 2
}

cleanup_lock() {
  rm -rf "$LOCK"
}

if [ ! -f "$OBJECTIVE" ]; then
  log "FATAL: objective file not found: $OBJECTIVE"
  exit 1
fi
acquire_lock
trap cleanup_lock EXIT

# Clear any stale STOP from a previous run.
rm -f "$STOP"
# Seed the rolling-memory file (gitignored) if it doesn't exist yet.
if [ ! -f "$STATE" ]; then
  printf '# board-monitor rolling memory — newest entry last; trimmed to last %s lines each iteration.\n# One line per cycle: <ISO time> | <action taken> | <items touched + how many cycles running>\n' "$STATE_KEEP" > "$STATE"
fi
# Record our PID so the README's stop/observe commands (kill "$(cat loop.pid)")
# target the live driver. loop.sh never wrote this before, so it drifted stale
# on every restart.
echo "$$" > "$DIR/loop.pid"
# Run from the repo so the Claude Code harness (no -C flag) uses $REPO as cwd.
# All file refs above are absolute, so this cd is safe; codex passes -C explicitly.
cd "$REPO" || { log "FATAL: cannot cd to $REPO"; exit 1; }
log "board-monitor loop START (project ${PROJECT_ID}, repo ${REPO}, objective ${OBJECTIVE}, state-dir ${DIR}, pid $$, agent ${AGENT}, sleep ${SLEEP}s, max ${MAX}, iter-timeout ${ITER_TIMEOUT}s, state-keep ${STATE_KEEP})"

short_streak=0
for (( i=1; i<=MAX; i++ )); do
  if [ -f "$STOP" ]; then log "STOP file present — exiting before iteration $i"; rm -f "$STOP"; break; fi

  log "--- iteration $i START ---"
  # Re-read the objective every iteration so it can be steered LIVE (edit
  # objective.md and the next cycle picks it up — no loop restart needed).
  OBJ="$(cat "$OBJECTIVE")"
  start=$(date +%s)
  case "$AGENT" in
    codex)
      # codex needs explicit cwd (-C) and the hook-trust bypass so the repo's
      # Claude-style hooks fire through codex's bridge.
      # gpt-5.3-codex-spark (the global config default) has near-zero quota
      # (exhausted until ~Jun 12); pin the monitor to gpt-5.5 so the loop
      # doesn't immediately exit=1 on a usage-limit error every cycle.
      timeout "$ITER_TIMEOUT" codex exec \
        --dangerously-bypass-approvals-and-sandbox \
        --dangerously-bypass-hook-trust \
        -m "${MONITOR_CODEX_MODEL:-gpt-5.5}" \
        -C "$REPO" \
        "$OBJ" >> "$LOG" 2>&1
      ;;
    *)
      # Claude Code headless (default). cwd is $REPO (set at startup), so the repo
      # is already an allowed dir — no --add-dir needed. Hooks fire natively.
      # bypassPermissions = no permission prompt blocks the headless run. The
      # objective goes in via STDIN (not a positional arg) so it can't be mistaken
      # for a flag value.
      printf '%s' "$OBJ" | timeout "$ITER_TIMEOUT" claude \
        --print \
        --permission-mode bypassPermissions >> "$LOG" 2>&1
      ;;
  esac
  code=$?
  dur=$(( $(date +%s) - start ))
  log "--- iteration $i END exit=$code dur=${dur}s ---"

  # Bound the rolling memory deterministically (don't trust the LLM to trim):
  # keep only the last STATE_KEEP lines so each fresh session reads a small,
  # recent window and per-iteration context stays flat.
  if [ -f "$STATE" ]; then
    tail -n "$STATE_KEEP" "$STATE" > "$STATE.tmp" 2>/dev/null && mv -f "$STATE.tmp" "$STATE"
  fi

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
