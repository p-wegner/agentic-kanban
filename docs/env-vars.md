# Environment variables

The board-owned environment variables that have a naming/precedence story worth writing
down — the `#615`-renamed set, the port ladders, worktree/session context, process
supervision, and test-run scoping. **The naming rule: a board variable is `KANBAN_*`.** In
an agent's spawn env — sitting beside the agent CLI's own variables — an unprefixed name is
genuinely ambiguous about who owns it, and 34 prefixed vars had grown alongside a dozen bare
ones with no list anywhere.

This **is** the complete inventory, and a test says so (#707). Every `process.env.<NAME>`
read under `packages/*/src` is checked by `env-read-ownership.test.ts`: a board-owned name
(`KANBAN_*` or `AGENTIC_KANBAN_*`) must have a row on this page, and every other name must be
declared FOREIGN in that suite with a note saying whose it is. So a new variable cannot reach
master undocumented, and an unlisted `KANBAN_*` in code is a bug in one of the two, not a var
nobody wrote down. (The caveat this replaces was true when #690 filed it: 84 reads across 42
names were unforbidden and roughly a third undocumented.)

**The helper-argument hole is closed (#768).** A name read through a helper that takes it as
an ARGUMENT — `envPort("KANBAN_FLEET_PORT", …)` — used to be invisible: the read itself happens
inside the helper as `process.env[<expression>]`, and the suite merely *capped* those at a count
of 5 rather than naming them. A count says how many reads cannot be seen and never which
variable, which is exactly how `KANBAN_FLEET_PORT` and `KANBAN_GIT_HTTP_PORT` reached master with
no row here until #756 added them by hand. The suite now resolves the literal name argument of
every enumerated env-reader helper (`ENV_READER_HELPERS`: `envPort`, `readBoardEnv`) into a named
read and checks it against this page like a direct one — so a new `envPort("KANBAN_…")` with no
row here fails the gate.

What remains is **named, not counted**: the genuinely dynamic reads live in `DYNAMIC_ENV_READS`,
one entry per call site, each stating which variables that site can resolve to and why the
indirection belongs there (`envPort`'s own body, `readBoardEnv`'s canonical/legacy pair, the mock
agent's `MOCK_<FLAG>` derivation, and the Pi API-key sweep). The list is shrink-only in both
directions — a new dynamic site fails until it is declared, and a declared site that disappears
must have its entry deleted. It was deliberately not driven to zero: `env[name]` inside a helper
is the correct implementation of that helper, and forcing it out would push the pattern into a
shape the scanner also cannot see.

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
| `KANBAN_FLEET_PORT` | Port for the worker-fleet listener (register/heartbeat/ws, the allowlisted board-MCP bridge at `/mcp` (#769), + `/health`, nothing else). **Unset = disabled**: no port is opened — and with no listener a remote builder gets no board tools, which is what its brief then says. |
| `KANBAN_FLEET_HOST` | Interface the fleet port binds (the worker-facing surface above, board API never). **Unset = `127.0.0.1`** since #753 — a cross-machine fleet must name the interface (or set `KANBAN_FLEET_INSECURE=1`). |
| `KANBAN_GIT_HTTP_PORT` | Port for the git smart-HTTP transport. **Unset = an OS-assigned port**, which changes every board boot. **REQUIRED whenever `KANBAN_FLEET_PORT` is set** (#776): the git transport refuses to start on an ephemeral port while a fleet listener is configured, because a worker holds the `gitPort` from its `assign` and rebuilds every clone/push URL from it. |
| `KANBAN_GIT_HTTP_HOST` | Interface the git transport binds. **Unset = `127.0.0.1`** since #753, same rule as `KANBAN_FLEET_HOST`. |
| `KANBAN_FLEET_INSECURE` | Set to exactly `1` to let both fleet listeners bind every interface with no interface named. Both are plaintext HTTP carrying a bearer credential, so this is the explicit "yes, on every network this machine is on" switch. Anything other than `1` (including `true`) keeps them on loopback. |
| `KANBAN_GIT_MAX_BODY_BYTES` | Cap on ONE git smart-HTTP request body, counted after gzip decompression (default 1 GiB). Raise it only for a repo whose real pushes exceed it. |
| `VITE_HOST` | Interface the Vite dev client binds (default `::`, every interface). **Set to `127.0.0.1` whenever a fleet listener is configured** — the dev client proxies `/api` to the unauthenticated board API, so a default bind publishes it on every interface. Read in `packages/client/vite.config.ts`; see [worker-fleet.md](worker-fleet.md). |
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
| `KANBAN_RETRY_TEST_FILES` | Flake-retry scope (#894): comma-separated `package:path` entries (e.g. `server:src/__tests__/x.test.ts`) — `test:mine` re-runs ONLY these files instead of the whole suite. Set by `verify-flake-retry.ts` for the gate's retry pass; the package label is required because vitest runs with the package as cwd, and an unlabeled entry is skipped rather than guessed. |
| `KANBAN_TEST_MAX_WORKERS` | Cap vitest workers. Set by the pre-merge gate (derived from live capacity since #909, bounded by `verify_max_workers_<projectId>` as a ceiling) AND, separately, by a BUILDER session's own launch env (also derived, so an agent's own `pnpm test:mine` is capped too — five uncapped worktree fans-out was the invisible multiplier #909 fixes). |
| `KANBAN_TEST_GUARDS_ONLY` | Set to 1 to make `test:mine` run ONLY the `@gate:always-run` guard suites — the narrowest verify tier. |
| `KANBAN_TEST_SELECTOR` | Which selector `test:mine` scopes with (#951). Unset (default) = `vitest related` + `KANBAN_TEST_FILES`, unchanged. `impact` = the test-impact skill's multi-signal ranking (import reach, name affinity, git change-set coupling, runtime coverage, failure history), which never returns a silent empty set. Opt-in and fail-open: skill missing, non-zero exit, an empty selection, or a selection left with nothing runnable after this runner's exclusions and package scope all fall back to `vitest related`, loudly. The selector ranks every test file in the repo and knows nothing about the per-package `exclude` list, so an excluded suite it names is dropped here — with its exclusion reason — rather than being silently skipped by vitest (a green for a suite that never ran) or failing the package with a bare `No test files found`. The `@gate:always-run` guard top-up runs either way. Not the default until #954 has produced a measured miss rate. |
| `KANBAN_TEST_MIN_SCORE` | The impact selector's score floor (default `1.0`), only read when `KANBAN_TEST_SELECTOR=impact`. Measured shape on this repo: a one-file change scores a handful of suites at 1.00 and then has a long tail tied at ~0.14, so `1.0` keeps the head and drops the tail. Non-numeric values are ignored with a warning. |
| `KANBAN_IMPACT_REBUILD` | Set to 1 to let the impact selector pass `--rebuild-if-stale` (default OFF). Off by default because the skill resolves its root via `git rev-parse --show-toplevel`, so a rebuild inside a WORKTREE writes a worktree-local `docs/tests/impact-map.json` — it helps nobody, lands in the branch diff, and breaks the single-writer property map freshness depends on (#952 owns keeping it fresh, on the main checkout). A stale map is not silent: the skill reports it and widens to the package tier. |
| `KANBAN_IMPACT_CLI` | Explicit path to the test-impact skill's `impact.mjs`, overriding the search. Absent, `test:mine` looks for `.claude/skills/test-impact/tools/impact.mjs` (then the `.codex` twin) under the repo/worktree root first — the copy the board materializes into every worktree — and then under `$HOME`. A path that does not exist disables the selector rather than falling through to the search, so an explicit setting is never silently ignored. |
| `KANBAN_TEST_NO_COVERAGE_PROBE` | Set to 1 to skip `test:mine`'s per-file coverage probe (#762), which forces a package's full suite when a changed source file is imported by no suite. See [gate-test-selection.md](gate-test-selection.md). |
| `KANBAN_TEST_HERMETIC` | `report` (default) or `strict`. `test:mine` snapshots `git status` around the run and names any path whose status changed (#680) — a test that writes into the checkout is what makes the repo-scanning guard suites go red under load. `strict` FAILS the run on that drift; the default only reports it, because several agents share this checkout and a neighbour's edit is not this run's leak. Use `strict` on a dedicated runner. |
| `KANBAN_VERIFY_CONCURRENCY` | Cap concurrent verify-gate runs (the build semaphore). Unconditional override; absent, derived from live capacity (spare cores / free RAM) since #909 rather than a fixed 2. |
| `KANBAN_VERIFY_MAX_WORKERS` | Unconditional override for the verify gate's own vitest worker count (distinct from `KANBAN_TEST_MAX_WORKERS`, which is the env var test:mine reads — this is the input that sets it). Absent, derived from capacity bounded by `verify_max_workers_<projectId>` as a ceiling (#909). |
| `KANBAN_VERIFY_CHAIN_CONCURRENCY` | Cap concurrent whole verify chains across the server process. Default 1, so expensive pre-merge verify chains serialize instead of interleaving on a saturated host. |

## `AGENTIC_KANBAN_*` — the npm package's own surface

Board-owned, and deliberately not renamed (see below). Listed by name because "already an
unambiguous prefix" is an argument about the NAME and says nothing about what each one does.

| Variable | Purpose |
|---|---|
| `AGENTIC_KANBAN_DIR` | Data directory. Decides where `kanban.db` lives when no explicit `KANBAN_DB_URL` is set. |
| `AGENTIC_KANBAN_PLUGINS_DIR` | Where installed plugin checkouts live. Default `~/.agentic-kanban/plugins`. |
| `AGENTIC_KANBAN_BUNDLED_PLUGINS_DIR` | Override the directory the marketplace reads bundled plugins from. |
| `AGENTIC_KANBAN_BACKUP_DIR` | Where DB backups are written. Default `<data dir>/.db-backups`. |
| `AGENTIC_KANBAN_BACKUP_MAX_BYTES` | Cap on total backup size before the oldest are pruned. |
| `AGENTIC_KANBAN_PROCESS_AUDIT_LOG` | File the process guard appends kill-allowed / kill-blocked decisions to. |
| `AGENTIC_KANBAN_CONTAINER` | Set inside a containerized builder, so code can tell it is not on the host. |
| `AGENTIC_KANBAN_SESSION_ID` | The board session an agent subprocess belongs to. |

## disclose-context.mjs hook

Env knobs for the `.claude/hooks/disclose-context.mjs` PostToolUse hook (#922) — see its
file header for what the hook does.

| Variable | Purpose |
|---|---|
| `KANBAN_DISCLOSE_STATE_DIR` | Where per-session "already injected" state lives. Default: OS tmpdir. |
| `KANBAN_DISCLOSE_LOG` | Set to 1 for a one-line stderr trace per invocation (visible in `claude --debug`). |
| `KANBAN_DISCLOSE_ALL_TOOLS` | Set to 1 to also handle Read/Edit/Write (normally Claude Code's own progressive disclosure covers those). |
| `KANBAN_DISCLOSE_DISABLED` | Set to 1 to no-op the hook (the control arm of the eval). |

## Runtime tuning

| Variable | Purpose |
|---|---|
| `KANBAN_STATUS_TRANSITION_STRICT` | Set to 1 to make an illegal workspace status transition throw (`IllegalStatusTransitionError`) instead of warning and falling through to the terminal guard. |
| `UV_THREADPOOL_SIZE` | Node's libuv pool, default 4 and shared by every async fs op *and* the libsql file driver. The board raises it to 12 **if unset** (`packages/server/src/uv-threadpool.ts`, imported first from every entry point since libuv reads it lazily at the first submission): at 4, a single-SELECT endpoint queued behind a workspace-summary rebuild and measured 6–24s. An explicit value always wins. |

## Not renamed, and why

- **`AGENTIC_KANBAN_*`** (`AGENTIC_KANBAN_DIR`, `_PLUGINS_DIR`, `_BUNDLED_PLUGINS_DIR`,
  `_BACKUP_DIR`, `_BACKUP_MAX_BYTES`, `_PROCESS_AUDIT_LOG`, `_CONTAINER`, `_SESSION_ID`) —
  already an unambiguous board prefix. Renaming would churn the npm package's documented
  surface for no gain in clarity.
- **The `scaffold/` guards' variables** (`ALLOW_CROSS_WORKTREE_WRITE`, `ALLOW_VITAL_DESTROY`,
  `VITAL_FILES`, `VERIFY_GATE_COMMAND`, `VERIFY_GATE_MAX_REPAIR_ATTEMPTS`) — these ship INTO
  other people's repos as hook scripts. Renaming them is a separate decision with its own
  upgrade story, and doing it silently here would break checkouts scaffolded by an older board.
- **Third-party and OS variables** (`ANTHROPIC_*`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
  `PI_CODING_AGENT_DIR`, `GRADLE_USER_HOME`, `GIT_CONFIG_*`, `DOCKER_HOST`, `PATH`, `PATHEXT`,
  `HOME`, `APPDATA`, `LOCALAPPDATA`, `ProgramFiles`, `TEMP`, …) — not ours to name. Each one
  the board actually reads is declared in `env-read-ownership.test.ts`'s `FOREIGN` map with a
  note on whose it is; that map, not this bullet, is what the gate checks.
- **`NODE_ENV`, `VITEST`, `VITEST_*`** — runner conventions.
