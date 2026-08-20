# Example: multi-repo project + a multi-container service stack (postgres + redis)

A harder worked reference for [decision 011 — per-workspace service stacks](../../docs/decisions/011-per-workspace-service-stacks.md) than [`multi-repo-postgres`](../multi-repo-postgres/). It shows a **full-stack** project — a `frontend` and a `backend` repo — whose stack is **two containers** (a postgres database **and** a redis cache), so every workspace/ticket gets its own isolated database *and* cache, each on its own free host port.

This is the shape most real apps actually have (DB + cache/queue), and it exercises the parts of the feature that a single-container stack does not:

- **Multiple named host ports** allocated collision-free per workspace (`KANBAN_SVC_DB_PORT`, `KANBAN_SVC_CACHE_PORT`).
- **Multi-service health-gating** — `up -d --wait` blocks until **both** postgres and redis report healthy, so the agent never races a half-up stack.
- **Two named volumes + a private network** isolated per workspace.
- The **admission cap** ([#56](../../docs/decisions/011-per-workspace-service-stacks.md)) — each workspace is now 2 containers, so an over-subscribed host is exactly what `max_concurrent_stacks` protects against.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| `frontend` repo | any git repo | The UI. Registered as an additional project repo. |
| `backend` repo | any git repo | The API. Holds `docker-compose.yml` (copy the one in this folder to its root). Registered as the project's **leading repo**. |
| [`docker-compose.yml`](./docker-compose.yml) | in the `backend` repo root | postgres + redis. Publishes `${KANBAN_SVC_DB_PORT}:5432` and `${KANBAN_SVC_CACHE_PORT}:6379`, all namespaced by `COMPOSE_PROJECT_NAME`. |
| `servicesConfig` | on the project (DB) | Declares the stack: compose file, repo, and the **two** ports to allocate. |

## Declare the service stack (`servicesConfig`)

Set the project's `servicesConfig` — in **Settings → project → Service stack**, or directly:

```bash
curl -X PATCH http://localhost:3001/api/projects/<projectId> \
  -H 'content-type: application/json' \
  -d '{
    "servicesConfig": {
      "enabled": true,
      "composeFile": "docker-compose.yml",
      "composeRepo": "backend",
      "ports": ["db", "cache"],
      "readyTimeoutMs": 120000,
      "env": { "POSTGRES_PASSWORD": "kanban" }
    }
  }'
```

- `ports: ["db", "cache"]` — allocate **two** free host ports; the board exposes them as `KANBAN_SVC_DB_PORT` / `KANBAN_SVC_CACHE_PORT`, and the compose file publishes them.
- Connection strings the agent uses:
  - postgres → `postgres://kanban:kanban@${KANBAN_SERVICE_HOST:-localhost}:${KANBAN_SVC_DB_PORT}/app`
  - redis → `redis://${KANBAN_SERVICE_HOST:-localhost}:${KANBAN_SVC_CACHE_PORT}`

Everything else (per-workspace isolation, `KANBAN_SERVICE_HOST` by deployment mode, teardown on merge/delete) works exactly as in the [`multi-repo-postgres`](../multi-repo-postgres/README.md) example — read that for the full walkthrough.

## Capacity: the admission cap (#56)

Each workspace here runs **2 containers**. Peak resource use is `WIP × per-stack footprint`, so on a smaller host set a ceiling:

```bash
# Global setting: at most 4 stacks up at once; further creates DEFER (the agent still
# launches, the stack comes up once one frees). Empty/0 = unlimited (default).
pnpm cli -- preferences set max_concurrent_stacks 4
```

In a DinD deployment the `KANBAN_STACK_PORT_RANGE` block size is *also* a natural cap — a stack that can't draw a port from the range defers the same way.

## Cleaning up leaked stacks (#53)

If the board's instance id ever changes (a DB reset/restore, an `AGENTIC_KANBAN_DIR` change, or a worktree dev server falling through to `~/.agentic-kanban`), the old id's stacks are no longer reclaimed by the automatic reaper. Sweep them deliberately:

```bash
pnpm cli -- services reap                       # dry-run: this instance's orphans
pnpm cli -- services reap --yes                 # tear them down
pnpm cli -- services reap --all-instances       # dry-run: EVERY board-managed stack on the daemon
pnpm cli -- services reap --instance <oldId> --yes   # reap a specific stranded id
```

A stack is never reaped while its workspace is still live in the current DB, and unrelated (non-board) compose projects are never touched.

## DooD safety (#55)

If you run the board in a container with the host `docker.sock` mounted (DooD) rather than the recommended DinD (`docker-compose.dind.yml`), the boot preflight will loudly warn about the two silent traps — an undialable `KANBAN_SERVICE_HOST=localhost` and a data root the daemon can't see (empty bind mount). Prefer DinD; it avoids both by construction.
