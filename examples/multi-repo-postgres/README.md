# Example: multi-repo project + a postgres service stack

A worked reference for [decision 011 — per-workspace service stacks](../../docs/decisions/011-per-workspace-service-stacks.md). It shows a project made of **two repos** (a `frontend` and a `backend`) that also declares a **postgres sidecar**, so every workspace/ticket gets its own isolated database on its own free host port.

This is the shape most real projects want: the app needs a live DB to run and test against, and parallel tickets must not fight over one shared instance.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| `frontend` repo | any git repo | The UI. Registered as an additional project repo. |
| `backend` repo | any git repo | The API. Holds `docker-compose.yml` (copy the one in this folder to its root). Registered as the project's **leading repo**. |
| [`docker-compose.yml`](./docker-compose.yml) | in the `backend` repo root | The postgres sidecar. Publishes `${KANBAN_SVC_DB_PORT}:5432`, namespaced by `COMPOSE_PROJECT_NAME`. |
| `servicesConfig` | on the project (DB) | Declares the stack: which compose file, which repo, which ports to allocate. |

## 1. Register the repos

Register the leading repo (the one that holds the compose file — here `backend`), then add the sibling repo:

```bash
# Leading repo — holds docker-compose.yml at its root
pnpm cli -- register /path/to/backend

# Add the second repo to the same project (via the project's repos API / Settings → Repos).
# The frontend becomes a sibling worktree in every workspace.
```

Copy [`docker-compose.yml`](./docker-compose.yml) from this folder into the **root of the `backend` repo** and commit it (the compose file is resolved relative to its repo root).

## 2. Declare the service stack (`servicesConfig`)

Set the project's `servicesConfig` — in **Settings → project → Service stack**, or directly:

```bash
curl -X PATCH http://localhost:3001/api/projects/<projectId> \
  -H 'content-type: application/json' \
  -d '{
    "servicesConfig": {
      "enabled": true,
      "composeFile": "docker-compose.yml",
      "composeRepo": "backend",
      "ports": ["db"],
      "readyTimeoutMs": 120000,
      "env": { "POSTGRES_PASSWORD": "kanban" }
    }
  }'
```

- `composeRepo: "backend"` — the compose file lives in the backend repo, not the leading repo. (Omit / `null` if it's in the leading repo.)
- `ports: ["db"]` — allocate ONE free host port named `db`; the board exposes it as `KANBAN_SVC_DB_PORT` and the compose file publishes it as `${KANBAN_SVC_DB_PORT}:5432`.
- `env` — extra static vars written verbatim into the generated env file (here the postgres password).

## 3. What happens on workspace create

For each new workspace the board:

1. Allocates a **free host port** for `db` (e.g. `54187`) — collision-free across all projects/workspaces.
2. Computes a deterministic `COMPOSE_PROJECT_NAME` = `ak-<projectId8>-ws-<offset>`.
3. Writes `<backendWorktree>/.kanban/services.env`:
   ```sh
   COMPOSE_PROJECT_NAME=ak-1a2b3c4d-ws-42
   KANBAN_SVC_DB_PORT=54187
   POSTGRES_PASSWORD=kanban
   KANBAN_STACK=1
   ```
4. Runs `docker compose -p <name> -f docker-compose.yml --env-file .kanban/services.env up -d --wait` — blocking on the postgres healthcheck.
5. Tells the agent (in `CLAUDE.local.md`) that the stack is up, the allocated port, and to `source .kanban/services.env`.

The agent then connects the backend to `postgres://kanban:kanban@${KANBAN_SERVICE_HOST:-localhost}:${KANBAN_SVC_DB_PORT}/app`.

`KANBAN_SERVICE_HOST` (also written into `.kanban/services.env`) is the host the agent must dial to reach the stack, and it **differs by deployment mode** because the board, the Docker daemon, and the published port can live in different network namespaces:

- **Windows-native / board-on-host** — `localhost` (the default; nothing to set).
- **DooD** (host socket) — `host.docker.internal` (the port is published on the host; the board also needs `extra_hosts: ["host.docker.internal:host-gateway"]`).
- **DinD** (nested daemon) — `dind` (reach the postgres by the dind service name over the shared `dind-net`).

Always use `${KANBAN_SERVICE_HOST:-localhost}` rather than a hardcoded `localhost`. See [deployment.md → Per-workspace service stacks](../../docs/deployment.md#per-workspace-service-stacks-dinddood).

## 4. Teardown

On merge / delete / abandon the board runs `docker compose -p <name> down -v --remove-orphans` — containers, network, and the `pgdata` volume all vanish (the DB is disposable by design). Orphaned stacks left by a crash are reaped on server startup (matched by the `ak-…-ws-…` project-name prefix).

## Running the board where this works

- **Windows-native / local:** Docker Desktop on the host — nothing else to configure.
- **Containerized board (Linux server):** wire in a Docker daemon via **DooD** or **DinD** — see [deployment.md → Per-workspace service stacks](../../docs/deployment.md#per-workspace-service-stacks-dinddood). Because this example's compose file bind-mounts nothing from the repos (postgres uses a named volume), plain DooD works without the identical-path caveat; a compose file that DID bind-mount repo source would need DinD (or the host-bind-mount DooD setup).
