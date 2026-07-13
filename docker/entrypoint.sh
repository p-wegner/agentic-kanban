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

exec "$@"
