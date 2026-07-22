#!/bin/sh
# Agentic Kanban container entrypoint.
#
# Auth bridge: the server deliberately strips every ANTHROPIC_*/CLAUDE_CODE_* var from the
# env it spawns agents with (cross-profile credential-bleed guard in buildSpawnEnv), so
# container env vars alone never reach an agent. Bridge them into a Claude profile file
# (~/.claude/settings_docker.json) and select it via the claude_profile preference.
# Alternative: mount a host ~/.claude with existing credentials to /root/.claude and set
# no env vars — then this bridge is skipped.
set -e

mkdir -p "${AGENTIC_KANBAN_DIR:-/data}" "${KANBAN_REPOS_DIR:-/data/repos}" "$HOME/.claude"

# Initialize the database (migrate + seed) BEFORE anything else touches it. The auth
# bridge below runs `preferences get/set`, which opens a DB connection as a side effect
# (creating an empty file via migrations) — if that ran first, the `dev` command's own
# "no DB file -> seed" first-run check would see an already-existing file and silently
# skip seeding builtin tags/skills/workflows in a fresh container (finding 25). `init` is
# idempotent (seed() upserts, never duplicates), so running it on every start — including
# restarts of an already-seeded container — is safe.
node dist/cli/index.js init >/dev/null 2>&1 \
  || echo "[entrypoint] db init failed (non-fatal — the dev server will retry)"

if [ -n "$ANTHROPIC_API_KEY" ] || [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
  node -e '
    const { writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const env = {};
    if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const path = join(process.env.HOME, ".claude", "settings_docker.json");
    writeFileSync(path, JSON.stringify({ env }, null, 2) + "\n");
    console.log("[entrypoint] wrote Claude profile", path, "with", Object.keys(env).join(", "));
  '
  # Select the docker profile unless the user already chose one. Non-fatal: the
  # preference can also be set later via Settings → Agent. The CLI prints log lines
  # (e.g. "[db] opening ...") before the value, so only the LAST line is the answer.
  current="$(node dist/cli/index.js preferences get claude_profile 2>/dev/null | tail -n 1 || true)"
  if [ -z "$current" ] || [ "$current" = "(not set)" ]; then
    node dist/cli/index.js preferences set claude_profile docker \
      || echo "[entrypoint] could not set claude_profile preference (set it in Settings → Agent)"
  fi
fi

# Per-workspace service stacks (decision 011): if a Docker daemon is wired up — either DinD
# (DOCKER_HOST=tcp://dind:2375) or DooD (host socket mounted at /var/run/docker.sock) — wait
# for it to accept connections before starting the server, so the startup orphan-stack reaper
# and the first workspace's `compose up` don't race a daemon that isn't listening yet. This is
# best-effort: if no daemon is configured, or it never comes up, we log and start anyway (the
# board's dockerAvailable() guard makes stacks degrade gracefully). The DinD sidecar can take a
# few seconds to boot its nested daemon.
if [ -n "$DOCKER_HOST" ] || [ -S /var/run/docker.sock ]; then
  echo "[entrypoint] docker daemon configured (DOCKER_HOST=${DOCKER_HOST:-unix:///var/run/docker.sock}); waiting up to 30s..."
  waited=0
  until docker version >/dev/null 2>&1; do
    if [ "$waited" -ge 30 ]; then
      echo "[entrypoint] docker daemon not ready after 30s — starting server anyway (service stacks will retry / degrade)"
      break
    fi
    waited=$((waited + 2))
    sleep 2
  done
  if docker version >/dev/null 2>&1; then
    echo "[entrypoint] docker daemon ready after ${waited}s"
  fi
fi

exec "$@"
