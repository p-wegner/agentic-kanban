# Dimension: devcontainer / containerized builders

Tune how the board runs **builder agents inside containers** rather than as host
processes. Distinct from the docker/multi-repo dimension — that one is about
per-workspace **service stacks the agent dials** (`servicesConfig`, compose,
DinD) and is SEALED. This one is about the **agent's own execution environment**.

Do not let `multirepo.md`'s "SEALED" marker or the
`docker-in-docker-already-supported` memory talk you out of this dimension. Both
refer to service-stack DinD. Agent containerization was greenfield as of round 1.

## Why it matters

`docs/decisions/011-per-workspace-service-stacks.md:153-162` treats DooD as
**host-root-equivalent for all agent code**, because the Docker socket bypasses
the board's PreToolUse hooks. Running the agent *inside* a container inverts that
argument — this is the strongest motivation available, and it is a security
argument, not an ergonomics one. It only pays off if the mounts are tight
(see the security trap below).

## Instrument (decide before building)

Per-ticket vector, read from ground truth, never the board's self-report:

| Signal | Where to read it | Trap |
|---|---|---|
| Did it containerize? | `[agent] launching: command=docker` in the dev log (host runs show `…\claude.exe`) | a `[devcontainer] builder containerized:` line alone only proves *provisioning* |
| Did the agent authenticate? | `system/init` event + non-zero `output_tokens` | exit 127 / instant exit = launch failure dressed as "completed" |
| Is the worktree diff sane? | `git status --porcelain \| wc -l` **inside** the container | this is the CRLF killer — see below |
| Did real work land? | files on disk in the worktree + `git log main..HEAD` | board status said `idle`/`completed` on a 127 exit |
| Are board tools present? | `mcp_servers` + `mcp__` entries in `system/init` `tools` | `status: "pending"` with zero `mcp__` tools = MCP never connected |

## The four traps, in the order they bite

Every one of these was found live in round 1; all four produce a *plausible*
failure that looks like something else.

1. **CRLF makes the whole repo look modified.** A Windows checkout
   (`core.autocrlf=true`) puts CRLF on disk; the Linux container's git has no
   autocrlf, so every CRLF file compares as fully rewritten — measured **151 of
   170 tracked files (89%)** on taskflow. This would hand `getWorkingTreeDiff()`
   the entire repo and make review, conflict detection and merge meaningless.
   Fix by propagating the host's autocrlf into the container (150 dirty → 1), not
   by renormalising the repo. Also set `safe.directory` (uid mismatch on a bind
   mount).
2. **The host-resolved binary path.** Providers resolve their command on the HOST
   (`where claude.exe` → `C:\Users\…\claude.exe`). Passed into a container that
   is exit 127 `executable file not found in $PATH`. Path *mappings* cannot fix
   it — the binary is outside every mounted tree. Reduce to the bare program name
   and let the container's PATH resolve it.
3. **The host env clobbers the container's.** `buildSpawnEnv()` returns a full
   copy of the host `process.env`. Forwarding it wholesale sends
   `-e PATH=C:\Windows\…`, replacing the Linux PATH — **also exit 127, with the
   binary installed and on PATH**, which reads exactly like trap 2 and will send
   you in circles. Forward by allowlist; the container owns its environment.
4. **Artifacts outside the mounted trees.** The generated MCP config lives in the
   host temp dir — neither the worktree nor the profile — so the launch dies with
   `MCP config file not found`, showing a nonsense path like
   `/workspaces/<wt>/C:\Users\…\config.json` (host path appended to container
   cwd). That shape is the tell: an untranslated host path.

## Architecture that worked

```
provision  ->  `devcontainer up`   (cold, once per workspace, shell OK)
agent run  ->  `docker exec`       (hot path)
```

Do **not** run the agent through `devcontainer exec`: the npm-global
`devcontainer` is a `.cmd` shim on Windows, so it forces `shell: true`, and
`shouldDetachAgent()` refuses to detach a shell-spawned agent (detaching breaks
its stdout pipe). `docker` is a real executable everywhere. `devcontainer up`
reports `{containerId, remoteUser, remoteWorkspaceFolder}`, so the hot path never
needs the shim.

Containerize as a **pure transformation of the finished `AgentLaunchConfig`**,
between `buildLaunchConfig()` and the single `spawn()` in `agent.service.ts`.
Every provider becomes containerizable without knowing the feature exists, and
the transform is unit-testable without Docker. Make it best-effort: setting off,
no `devcontainer.json`, missing CLI, failed `up` → fall back to the host rather
than failing the workspace.

`devcontainer up` is **idempotent** (reuses the container, returns the same
handle), so the handle never needs persisting — which avoids a schema migration
entirely. But it also means **changing mounts does not take effect until you
`docker rm -f` the container**; a mount fix that "didn't work" is usually this.

## Security trap (do not skip)

The recipe that makes auth work is bind-mounting the host `~/.claude`. Mounted
whole and read-write, the agent inside can read and overwrite the host's OAuth
credentials, settings and every past transcript — giving back most of the
isolation that motivated containerizing at all. Auth is **OAuth tokens, not a
static API key** (`.credentials.json` → `claudeAiOauth`, access ~24h, refresh
~16d), so the container must be able to refresh, and refresh rewrites the file:
a read-only mount is not sufficient, and a single-*file* bind mount breaks on the
atomic rename. Mount a directory; narrow it to a board-owned minimal profile.

## Fixture

`C:\projects\andrena\exp\taskflow` (TS) — now carries a committed
`.devcontainer/devcontainer.json` (typescript-node:22, `remoteUser: node`,
postCreate installs the Claude CLI). Deliberately declares **no credential
mount**: the board injects that via `devcontainer up --mount`, which is the
realistic split (repo owns its toolchain, board owns the profile).

The `.devcontainer` must be **committed** — a new worktree checkout will not
contain uncommitted fixture files, and the feature then silently no-ops.

## Round 1 outcome (2026-07-20)

Landed `feat(#132)` — opt-in `devcontainer_builders`, off by default. Verified
live: containerized builder authenticated as the host profile, initialized with
cwd inside the container, implemented the fixture ticket (new route, new test,
app wiring) with a clean 3-file `git status`.

**NOT sealed.** Two blockers keep containerized builders below host parity:

- **#135 (critical)** — `setup_script` runs on the HOST, so pnpm's node_modules
  symlinks point at Windows store paths and nothing resolves in the container
  (`Cannot find module .../vitest.mjs`). The agent can write code but cannot run
  tests, so it cannot honestly reach ready-for-merge. Needs provisioning moved to
  workspace creation, then setup dispatched through the container.
- **#136 (high)** — board MCP tools unreachable. The MCP config is a host-stdio
  server, and bind-mounting the board repo will NOT fix it: the MCP server opens
  the DB via `better-sqlite3`, a native Windows binary. Needs an HTTP transport +
  `host.docker.internal`.

Plus #133 (whole-profile RW mount), #134 (`~/.claude.json` sits outside the
mounted profile → config-not-found noise on stderr every turn).

Start round 2 at #135 — it is the one that decides whether the feature is usable.

## Side finding

**#137** — `validate-command-safety.js` blocked a plain `curl -X POST /api/issues`
because `referencesDb()` matches the raw command string *including heredoc
payloads*, so a ticket body discussing the DB filename plus a `>/dev/null`
redirect reads as a destructive op. Worse, its pre-block backup resolves to
`<mainCheckout>/packages/server/kanban.db`, which does **not exist** in the
`C:\projects\…` clone — the live DB is the home fallback — so the backup net it
advertises is silently inoperative there. Expect this guard to fire while working
this dimension; per CLAUDE.md, stop and ask rather than routing around it.
