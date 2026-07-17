# Decision 011: Per-workspace Docker service stacks (+ DinD/DooD for a containerized board)

## Date: 2026-07-14

> Note: the shared spec called this "009-per-workspace-service-stacks.md", but decision
> numbers 009 and 010 were already taken (`009-dependency-pinning-by-blast-radius`,
> `010-decompose-contract-symmetry`). This record is numbered **011** instead. Agent D's
> deployment half appends to THIS file.

## Context
The board began as a single-user, local-first tool on Windows. Two things have grown past
that origin:

1. **Multi-repo projects already exist.** A project's "leading repo" is `projects.repoPath`;
   additional repos are `repos` rows, and per-workspace sibling worktrees are `repos` rows
   with a `workspaceId`. So a ticket can already span a frontend + backend checkout.
2. **A real runtime dependency is often missing.** Those repos frequently need a live service
   to run/test against — most commonly a database. Today the agent has no isolated, disposable
   instance of that, so parallel tickets would fight over one shared service and its ports.

Separately, the deployment target is broadening from "runs on the developer's Windows box" to
"runs as a Linux container on a server". A containerized board that wants to drive Docker
Compose for project stacks needs Docker access from *inside* the container.

## Decision
A project may declare a **service stack** — a Docker Compose file (e.g. a postgres sidecar) —
and every workspace gets its OWN isolated instance of it. The board brings the stack UP on
workspace create (health-gated via `up -d --wait`) and DOWN on merge/delete/abandon, and reaps
orphaned stacks on startup.

Isolation rests on two pillars:

- **Deterministic compose project name** — `ak-<instanceId8>-ws-<workspaceId12>`, sanitized to
  Compose's legal charset (see `composeProjectName` in `packages/shared/src/lib/service-ports.ts`).
  Keyed on the **workspace's unique id** (an earlier revision used the branch/port offset, which
  two workspaces on the same issue share — one's `down -v` wiped the other's live stack) and
  scoped to a **per-board-instance id** persisted in the preferences table
  (`getOrCreateServiceStackInstanceId`): every board instance on a host shares the Docker daemon
  (main checkout, worktree dev servers, DooD containers), so an unscoped namespace let one
  instance's startup reaper down ANOTHER instance's live stacks. The reaper filters candidates
  through `isInstanceManagedComposeProject` — exactly this instance's names, never another
  instance's, never unrelated compose projects. Legacy pre-instance-scoped names (`ak-ws-*`,
  still recognizable via `isManagedComposeProject`) are deliberately never auto-downed — their
  normal teardown still works via the STORED name, but orphans from before the upgrade need one
  manual `docker compose -p <name> down -v` sweep.
- **Free host ports allocated at CREATE time** — NOT derived deterministically, so stacks from
  different projects/workspaces can never collide. Ports are bound from `:0` on `127.0.0.1`,
  collected, then released for Compose to bind. The allocated `name -> port` map is stored on
  the workspace (`workspaces.service_state`) so teardown and the UI can read it; the generated
  env file exposes each as `KANBAN_SVC_<UPPER>_PORT` alongside `COMPOSE_PROJECT_NAME`.

Config is per-project (`projects.services_config`, a JSON `ServiceStackConfig`); the provisioned
result is per-workspace (`workspaces.service_state`, a JSON `ServiceStackState`).

### Two-tier deployment model
- **Windows-native (the local single-user case): NO DinD.** Docker Desktop on the host; the
  board shells out to `docker compose` directly. No nesting, no socket gymnastics.
- **Linux-container (the server case): DooD or DinD.** A board running inside a container needs
  Docker access — either Docker-out-of-Docker (mount the host socket) or Docker-in-Docker (a
  nested daemon). Agent D expands this half below (Dockerfile, compose overlays, the bind-mount
  path pitfall, resource caps).

### Graceful degradation is mandatory
Everything docker-related is guarded by `dockerAvailable()`. With no declared stack
(`servicesConfig` disabled or absent) OR no Docker present, behavior is **exactly unchanged** —
the local no-docker workflow is completely unaffected. Provisioning failures are non-fatal: the
workspace is still created (the stack state records `status: "error"`), matching setup-script
semantics.

## Foundation contract (this decision's first slice — Agent A)
- Migration `0101_service_stacks.sql`: `projects.services_config`, `workspaces.service_state`.
- Shared types `ServiceStackConfig` / `ServiceStackState` + `DEFAULT_SERVICE_STACK_CONFIG`.
- `docker-exec.ts` — the single sanctioned `docker` CLI adapter (mirrors `git-exec.ts`,
  node-only, barrel-exported as `export type *`).
- `service-ports.ts` — pure `composeProjectName` / `isInstanceManagedComposeProject` helpers
  (plus the legacy-shape recognizer `isManagedComposeProject`).
- `port-allocator.ts` — `allocateFreePorts(names)` free-port allocator (server).

## Deployment (Agent D)

The full operator guide lives in
[`docs/deployment.md` → Per-workspace service stacks](../deployment.md#per-workspace-service-stacks-dinddood);
this section records the deployment *decisions*.

### Image: CLI-only Docker, no bundled daemon
The runtime image (`Dockerfile`) installs `docker-ce-cli` + `docker-compose-plugin` from
Docker's **official apt repo** — the CLI and Compose **v2** plugin only, **not** the engine.
Rationale: the agents run inside the container and shell out to `docker compose`, so they need
the client, but the daemon is provided externally (DooD/DinD). Debian's `docker.io` was rejected
because it drags in the whole engine (heavy) and ships the deprecated Compose **v1**; Docker's
repo gives a lean, current CLI + the `compose` subcommand the board actually invokes.

### Two runtime options, one image
- **DooD (`docker-compose.yml`, commented option):** mount `/var/run/docker.sock`. Lightest, but
  carries the **bind-mount path pitfall** — the host daemon resolves a project compose file's
  bind-mounts against the **host** filesystem, so a named-volume repos dir (`/data/repos`) that
  doesn't exist on the host breaks every source bind-mount. Mitigation: repos MUST be a **host
  bind-mount at an identical path both sides** (`- /srv/kanban-data:/data`). Documented inline in
  the compose file and in deployment.md.
- **DinD (`docker-compose.dind.yml`, overlay):** a privileged `docker:27-dind` sidecar
  (`DOCKER_TLS_CERTDIR=""`, private `dind-net`) sharing the **same repos volume at the same path**
  (`/data`) as the board, with the board overriding `DOCKER_HOST=tcp://dind:2375`. Because daemon
  and board see identical paths, project bind-mounts resolve consistently — this is the
  recommended option when project compose files bind-mount source. Run as
  `docker compose -f docker-compose.yml -f docker-compose.dind.yml up`.

### Entrypoint daemon wait
When a daemon is wired in (`DOCKER_HOST` set, or `/var/run/docker.sock` present) the entrypoint
polls `docker version` for up to ~30s before `exec`-ing the server, so the startup orphan-stack
reaper and the first `compose up` don't race a not-yet-listening daemon (the DinD sidecar takes a
few seconds to boot). Best-effort: it starts the server anyway on timeout, and the existing
Claude auth-bridge logic is preserved unchanged and runs first.

### Two-tier model & resource caps (recorded)
- **Windows-native (local):** Docker Desktop on the host, board talks to it directly — **no DinD**.
- **Linux-container (server):** DooD or DinD as above.
- **Capacity:** peak resource use ≈ **WIP × per-stack footprint** (CPU/RAM/disk **and host
  ports**). Size the host for the peak or lower the WIP limit; teardown-on-merge + the startup
  reaper keep it bounded between bursts.

### Service-host reachability (`KANBAN_SERVICE_HOST`)
Once the board is containerized, the board process, the Docker daemon, and the published service
port live in **three different network namespaces**, so the host an agent dials to reach its stack
differs by mode. The board injects `KANBAN_SERVICE_HOST` (default `localhost`) into the generated
env file + agent context:
- **Windows-native / board-on-host:** `localhost` (default) — all three share the host namespace.
- **DooD:** `host.docker.internal` — the port is published in the **host** namespace; the board
  service also needs `extra_hosts: ["host.docker.internal:host-gateway"]` to resolve it.
- **DinD:** `dind` — the port is on the dind container, reached over the shared `dind-net` by the
  dind **service name**. For the *human/browser* to also reach it, the `dind` service forwards a
  fixed port block to the host (`ports: ["31000-31099:31000-31099"]`) and the allocator draws stack
  ports from that same block (`KANBAN_STACK_PORT_RANGE`), so a published stack port is browsable at
  `localhost:<port>` (#54). Without the range set, DinD stacks stay agent-only (the prior behavior).
Connection strings use `${KANBAN_SERVICE_HOST:-localhost}:${KANBAN_SVC_<NAME>_PORT}`.

### ⚠️ Security posture (recorded decision)
This feature deliberately widens the trust boundary and is opt-in for that reason. Mounting
`/var/run/docker.sock` (DooD) gives **every agent effectively ROOT on the host** — agents run
autonomously with `--dangerously-skip-permissions` (`IS_SANDBOX=1`), so `docker run -v /:/host …`
reads/writes the whole host as root, and doing it **through the Docker socket bypasses the board's
PreToolUse safety hooks** (which gate the agent's own tools, not the daemon it drives). The
privileged `docker:dind` daemon on `dind-net` (DinD) is a comparable escalation surface. Decision:
**treat DooD as host-root-equivalent for all agent code** — run the server only on a trusted,
isolated host/network, never a shared/production host, and never expose the board or dind daemon to
an untrusted network. Documented for operators in deployment.md.

### Cross-namespace port allocation (#51, #54 — largely closed)
The original allocator probed for a free port with `listen(0)` inside the **board process's own**
network namespace, but the port is published in the **host** (DooD) or **dind** (DinD) namespace —
which don't share a port table. So the probe tested the wrong machine, and it also freed the port
*before* compose bound it (a TOCTOU: a concurrent provision or an outbound socket could steal it in
the window). Under parallel WIP this surfaced as a `port already allocated` error; the 3× retry
re-rolled the same wrongly-scoped dice.

**Fix — draw from a dedicated, published range instead of probing (`KANBAN_STACK_PORT_RANGE`).** When
set (recommended for any containerized/DinD deployment; matches the `dind` service's forwarded block),
the allocator (`port-allocator.ts`) draws stack host ports from that block, excluding both an
in-process **reservation registry** (closes the TOCTOU — a port stays reserved until the provisioning
call releases it, so concurrent provisions never overlap) and the ports of this board's **live `up`
stacks** read from the DB (`getLiveStackHostPorts`, so a restart that clears the registry can't re-hand
a live port). Because the range is dedicated to this board's stacks and is the block actually published
on the publishing side, an unused number from it is bindable there *by construction* — no wrong-namespace
guess. Unset → legacy `listen(0)` ephemeral ports (correct for a native board that shares the host
namespace), still registry-guarded for the concurrency case.

Residual: the range bounds concurrent stacks to its size (a *feature* — a natural WIP cap, see #56),
and a port in the range taken by an unrelated host process is still possible (rare for a dedicated
block); the `port already allocated` retry — now reallocating a genuinely-different unused number —
remains the backstop. `serviceState.status="error"` on exhaustion stays non-fatal (graceful degradation).

### Reference examples
- `examples/multi-repo-postgres/` — a 2-repo (frontend + backend) project with a single
  postgres sidecar that publishes `${KANBAN_SVC_DB_PORT}:5432` and namespaces everything via
  `COMPOSE_PROJECT_NAME`, plus the registration + `servicesConfig` walkthrough.
- `examples/multi-repo-fullstack/` — the harder shape: a 2-repo project with a **multi-container**
  stack (postgres **+** redis). Exercises multiple named ports (`db`, `cache`), multi-service
  `up --wait` health-gating, two isolated volumes, and the admission cap (2 containers/workspace).

## Hardening (#53, #55, #56)

The three residual gaps from the first slice, all closed together as a hardening pass. Verified
live against real Docker with the `multi-repo-fullstack` fixture: two parallel postgres+redis
stacks came up health-gated on isolated ports/volumes, the wide sweep reaped a stranded-instance
stack (containers + both volumes) while leaving the co-resident stack AND an unrelated co-tenant
compose project untouched, and no stacks/volumes leaked after teardown.

### Admission cap — bounded concurrency (#56)
Peak resource use is `WIP × per-stack footprint`, and nothing capped it: `provisionServicesForLaunch`
provisioned unconditionally, so an over-subscribed host degraded into the leaked-stack feedback loop
(`up --wait` timing out under memory pressure → the compensating `down` also failing → leaks → more
pressure). A new global `max_concurrent_stacks` (default empty/0 = unlimited — zero behaviour change)
is enforced at that single choke point: past the cap the stack is **deferred**, not failed —
`ServiceStackState.deferred: true` (status stays "error" so every teardown/reaper path is unchanged),
the agent still launches, and the stack comes up on the next provisioning attempt once capacity frees.
Deferral is checked AFTER the free shared-worktree ADOPTION path (adopting a co-resident's stack never
counts against the cap) and BEFORE any side effect. The count is `countLiveStacks()` (DISTINCT live
"up" compose projects, so adopters count once). In DinD, `KANBAN_STACK_PORT_RANGE` size is a second,
independent natural cap.

### Wide-sweep GC — reclaiming stranded stacks (#53)
The periodic reaper only matches THIS instance's names (`isInstanceManagedComposeProject`, exact
current-id match). If the instance id changes — DB reset/restore, `AGENTIC_KANBAN_DIR` change, or the
documented home-fallback where a worktree dev server drops to `~/.agentic-kanban` — the old id's
`ak-<oldId>-ws-*` containers + volumes became unreclaimable by any automatic path. Fix: a deliberate,
operator-driven CLI sweep `pnpm cli -- services reap` (dry-run by default; `--instance <id>`,
`--all-instances`, `--yes`, `--json`). It is NOT automatic because two boards sharing one daemon is
exactly what instance-scoping permits — a naive "down anything not mine" would nuke a co-tenant.
Safety rests on a PURE planner (`planStackSweep`, `service-ports.ts`): a stack is reaped only when its
**ws-token matches no LIVE workspace row** in the current DB. ws-token (`serviceStackWsToken` = first 12
sanitized chars of the workspace id) is the STABLE identity that survives an id rotation — the
`ak-<inst>-` prefix does not — so a still-live workspace's stack is kept even after its name stopped
matching the exact reaper filter. Scope bounds the blast radius: `current` (default) touches only this
id's names; `instance <id>` a named stranded id (the precise home-fallback recovery); `all` every
managed name (with a loud co-tenant warning — a co-tenant board's live tokens live in a DB this sweep
cannot see). `parseManagedComposeName` recognizes any instance's names + the legacy shape.

### DooD misconfig preflight — failing loud, not silent (#55)
DinD works end-to-end; DooD (host `docker.sock` mounted into a containerized board) is the trap — one
uncommented line from looking configured while broken, every failure silent. A boot preflight
(`service-stack-preflight.ts`, gated on docker available + any project stack enabled; never blocks
startup) makes it loud: `classifyDockerDeployment` (pure — native/dood/dind from `DOCKER_HOST` + socket
presence + the `IS_SANDBOX`/`/.dockerenv` containerized marker) warns when a DooD/DinD deploy leaves
`KANBAN_SERVICE_HOST` at `localhost` (stacks come up but agents can't dial them), and in DooD it probes
whether the daemon can actually SEE the data root (a throwaway `busybox ls` of the bind-mount) — an
empty mount means the named-volume path pitfall silently mounted nothing. This covers the part of the
"board fs == daemon fs, board netns == publishing netns" assumption that CONFIG can repair by failing
loud; #51 covered the port-namespace part config can't.

## Consequences
- Parallel tickets each get a clean, isolated stack; no shared-service contention.
- Resource use scales with WIP × stack size — capacity must be sized for that (see deployment).
- The board owns a new external system (Docker); it is isolated behind one adapter
  (`docker-exec.ts`) and fully optional.
