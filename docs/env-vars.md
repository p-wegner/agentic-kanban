# Environment variables

The board-owned environment variables that have a naming/precedence story worth writing
down — the `#615`-renamed set, the port ladders, worktree/session context, process
supervision, and test-run scoping. **The naming rule: a board variable is `KANBAN_*`.** In
an agent's spawn env — sitting beside the agent CLI's own variables — an unprefixed name is
genuinely ambiguous about who owns it, and 34 prefixed vars had grown alongside a dozen bare
ones with no list anywhere.

This is **not yet a complete inventory**: a bare `process.env.<NAME>` read outside this
registry is not currently forbidden, and more of those exist in the tree than are documented
below (#690 tracks closing that gap). Treat an unlisted `KANBAN_*` variable you find in code
as undocumented, not as nonexistent.

The renamed vars in the first table are **data**, in
`packages/server/src/lib/env-registry.ts` (`KANBAN_ENV`), and this page is checked against
that array by `env-registry-doc-parity.test.ts`. A new registered variable cannot be added
without a row here, and a row cannot outlive its variable.

## Renamed in #615 — legacy name still works

Read through `readBoardEnv`, which prefers the `KANBAN_*` name, falls back to the legacy
one, and logs a one-time deprecation line naming the replacement. **Nothing breaks on
upgrade**; the old names keep working until a future release drops them.

| Variable | Legacy name (deprecated) | Purpose |
|---|---|---|
| `KANBAN_DB_URL` | `DB_URL` | Explicit libsql connection URL; wins over every other DB-location rule. |
| `KANBAN_ALLOW_DB_DESTROY` | `ALLOW_DB_DESTROY` | Set to 1 to let `db-repair` perform a destructive repair without `--force`. |
| `KANBAN_AGENT_COMMAND` | `AGENT_COMMAND` | Override the agent binary the board spawns. Presence also implies a mock agent. |
| `KANBAN_MOCK_AGENT` | `MOCK_AGENT` | Set to 1 to force the mock agent regardless of the configured profile. |
| `KANBAN_STUCK_BUILDER_TIMEOUT_MS` | `STUCK_BUILDER_TIMEOUT_MS` | How long a builder may be silent before the monitor treats it as stuck. |
| `KANBAN_PLUGIN_VIEW_READY_TIMEOUT_MS` | `PLUGIN_VIEW_READY_TIMEOUT_MS` | How long to wait for a plugin view's child server to become reachable. |
| `KANBAN_SLOW_REQUEST_THRESHOLD_MS` | `SLOW_REQUEST_THRESHOLD_MS` | Request duration above which the slow-request middleware logs a warning. |

`KANBAN_DB_URL` is resolved in `packages/shared/src/lib/db-path.ts` rather than through
`readBoardEnv` — that resolver is pure and lives in `shared`, so it cannot import the
server's registry. The precedence is identical and the parity test pins the pair.

## Ports and hosts

The board-server port has ONE ladder — `resolveBoardServerPort` in
`shared/lib/board-server-url.ts` (#615), guarded by
`board-port-ladder-single-source.test.ts`. Do not hand-roll it.

The board-**client** port has its own ladder — `resolveBoardClientPort`, same file (#690),
guarded by `board-client-port-ladder-single-source.test.ts`.

| Variable | Purpose |
|---|---|
| `KANBAN_SERVER_PORT` | The board's public API port (default 3001). |
| `KANBAN_CLIENT_PORT` | The board's web UI port (default 5173). |
| `KANBAN_BOARD_SERVER_PORT` | How a WORKTREE names the MAIN board's port — the top rung of the ladder. |
| `KANBAN_BOARD_CLIENT_PORT` | The main board's client port, as seen from a worktree. |
| `KANBAN_WORKTREE_SERVER_PORT` | This worktree's own server port (`3001 + N`). |
| `KANBAN_WORKTREE_CLIENT_PORT` | This worktree's own client port (`5173 + N`). |
| `KANBAN_INTERNAL_SERVER_PORT` | The port the backend BINDS in dev, behind the stable dev proxy. Never in a public URL. |
| `KANBAN_HOST` | Interface the board API binds. **Never `0.0.0.0`** — the API has no auth. |
| `KANBAN_FLEET_HOST` | Interface the fleet port binds (worker register/heartbeat/ws only). |
| `KANBAN_GIT_HTTP_HOST` | Interface the git transport binds. |
| `KANBAN_SERVICE_HOST` | Host that project service stacks bind. |
| `KANBAN_STACK_PORT_RANGE` | Port range allocated to project service stacks. |
| `KANBAN_TLS_CERT`, `KANBAN_TLS_KEY` | TLS material for the board server. |
| `SERVER_PORT`, `PORT` | Lower rungs of the port ladder, honoured for compatibility. |
| `VITE_PORT` | Vite's own client-port variable, honoured as a lower rung. |

## Worktree and session context

Set by the board on an agent subprocess; read by hooks and skills inside a worktree.

| Variable | Purpose |
|---|---|
| `KANBAN_WORKTREE_DIR` | Absolute path of the worktree the agent runs in. |
| `KANBAN_WORKTREE_BRANCH` | Branch checked out in that worktree. |
| `KANBAN_MAIN_CHECKOUT` | Absolute path of the board's main checkout, for hooks that self-locate. |
| `KANBAN_ISSUE_NUMBER` | Issue the workspace is for. |
| `KANBAN_SESSION_ID` | Board session id for the running agent. |
| `KANBAN_ISSUES_URL` | GitHub issues URL used by the `gh-issue` board-feedback mode. |
| `KANBAN_MCP_TOKEN` | Bearer token the spawned MCP server authenticates with. |
| `KANBAN_REPOS_DIR` | Root directory the board clones project repos into. |
| `KANBAN_AGENT_HANG_TIMEOUT_MS` | How long an agent may produce nothing before it is treated as hung. |

## Process supervision

| Variable | Purpose |
|---|---|
| `KANBAN_BOARD_SERVER_PID` | PID of the main board server, so cleanup never reaps it. |
| `KANBAN_PROTECTED_PIDS` | Extra PIDs cleanup must not touch. |
| `KANBAN_SKIP_ORPHAN_CLEANUP` | Disable the orphan-process sweep. |
| `KANBAN_HEARTBEAT_FILE` | Where the board writes its liveness heartbeat. |
| `KANBAN_EXIT_LOG_FILE` | Where process exits are recorded. |
| `KANBAN_SPAWN_BASELINE_FILE` | Baseline of pre-existing processes, so cleanup only reaps what the board started. |
| `KANBAN_SPAWN_BASELINE_PERSIST` | Persist that baseline across restarts. |

## Test-run scoping

| Variable | Purpose |
|---|---|
| `KANBAN_TEST_PACKAGES` | Restrict the pre-merge gate's test half to these packages. |
| `KANBAN_TEST_FILES` | Restrict it to these files. |
| `KANBAN_TEST_MAX_WORKERS` | Cap vitest workers. |
| `KANBAN_VERIFY_CONCURRENCY` | Cap concurrent verify-gate runs. |

## Not renamed, and why

- **`AGENTIC_KANBAN_*`** (`AGENTIC_KANBAN_DIR`, `_PLUGINS_DIR`, `_BUNDLED_PLUGINS_DIR`,
  `_BACKUP_DIR`, `_BACKUP_MAX_BYTES`, `_PROCESS_AUDIT_LOG`, `_CONTAINER`, `_SESSION_ID`) —
  already an unambiguous board prefix. Renaming would churn the npm package's documented
  surface for no gain in clarity.
- **The `scaffold/` guards' variables** (`ALLOW_CROSS_WORKTREE_WRITE`, `ALLOW_VITAL_DESTROY`,
  `VITAL_FILES`, `VERIFY_GATE_COMMAND`, `VERIFY_GATE_MAX_REPAIR_ATTEMPTS`) — these ship INTO
  other people's repos as hook scripts. Renaming them is a separate decision with its own
  upgrade story, and doing it silently here would break checkouts scaffolded by an older board.
- **Third-party and OS variables** (`ANTHROPIC_*`, `CLAUDE_*`, `CODEX_HOME`,
  `PI_CODING_AGENT_DIR`, `GRADLE_USER_HOME`, `GIT_CONFIG_*`, `DOCKER_HOST`, `PATH`, `HOME`,
  `APPDATA`, `TEMP`, …) — not ours to name.
- **`NODE_ENV`, `VITEST`, `VITEST_*`** — runner conventions.
