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

- **Deterministic compose project name** — `ak-<projectId8>-ws-<offset>`, sanitized to
  Compose's legal charset (`[a-z0-9-]`). Deterministic + project-scoped so teardown and the
  startup reaper never have to guess which stacks are ours (`isManagedComposeProject`). The
  `offset` is the existing `portOffsetFromName(branch)` (issue number, else a stable hash).
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
- `service-ports.ts` — pure `composeProjectName` / `isManagedComposeProject` helpers.
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

### Reference example
`examples/multi-repo-postgres/` — a 2-repo (frontend + backend) project with a postgres sidecar
that publishes `${KANBAN_SVC_DB_PORT}:5432` and namespaces everything via
`COMPOSE_PROJECT_NAME`, plus the registration + `servicesConfig` walkthrough.

## Consequences
- Parallel tickets each get a clean, isolated stack; no shared-service contention.
- Resource use scales with WIP × stack size — capacity must be sized for that (see deployment).
- The board owns a new external system (Docker); it is isolated behind one adapter
  (`docker-exec.ts`) and fully optional.
