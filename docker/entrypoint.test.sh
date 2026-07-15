#!/bin/sh
# Regression test for finding 25: docker/entrypoint.sh must run DB init (migrate + seed)
# BEFORE the auth bridge's `preferences get/set` calls, which open a DB connection as a
# side effect and would otherwise make the first-run "no DB -> seed" check silently skip
# seeding in a fresh container.
#
# Mocks `node` and `docker` on PATH, recording every invocation to a log file, then runs
# entrypoint.sh and asserts the recorded call order.
set -e

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin" "$WORK/data" "$WORK/home/.claude"
LOG="$WORK/calls.log"
: > "$LOG"

cat > "$WORK/bin/node" <<'EOF'
#!/bin/sh
echo "node $*" >> "$AK_TEST_LOG"
# Simulate `preferences get claude_profile` printing "(not set)" so the entrypoint's
# branch for setting the profile also runs (extra coverage of call order).
case "$*" in
  *"preferences get claude_profile"*) echo "(not set)" ;;
esac
exit 0
EOF
chmod +x "$WORK/bin/node"

cat > "$WORK/bin/docker" <<'EOF'
#!/bin/sh
echo "docker $*" >> "$AK_TEST_LOG"
exit 0
EOF
chmod +x "$WORK/bin/docker"

export PATH="$WORK/bin:$PATH"
export AK_TEST_LOG="$LOG"
export HOME="$WORK/home"
export AGENTIC_KANBAN_DIR="$WORK/data"
export KANBAN_REPOS_DIR="$WORK/data/repos"
export ANTHROPIC_API_KEY="test-key"
unset CLAUDE_CODE_OAUTH_TOKEN DOCKER_HOST || true

sh "$SCRIPT_DIR/entrypoint.sh" echo done >/dev/null

init_line="$(grep -n "^node dist/cli/index.js init" "$LOG" | head -n1 | cut -d: -f1)"
prefs_line="$(grep -n "^node dist/cli/index.js preferences" "$LOG" | head -n1 | cut -d: -f1)"

if [ -z "$init_line" ]; then
  echo "FAIL: entrypoint.sh never ran 'node dist/cli/index.js init'"
  cat "$LOG"
  exit 1
fi

if [ -z "$prefs_line" ]; then
  echo "FAIL: entrypoint.sh never ran a 'preferences' subcommand (auth bridge did not fire)"
  cat "$LOG"
  exit 1
fi

if [ "$init_line" -ge "$prefs_line" ]; then
  echo "FAIL: db init (line $init_line) did not run before the auth bridge's preferences calls (line $prefs_line)"
  cat "$LOG"
  exit 1
fi

echo "PASS: db init ran before the auth bridge's preferences calls"
