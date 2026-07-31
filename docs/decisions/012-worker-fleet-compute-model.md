# Decision 012: Worker fleet — a peer/worker compute model for agent execution

## Date: 2026-07-31

## Context

Until now the board and the machine that runs agents were the same machine. `POST
/api/workspaces` carves a git worktree out of the local checkout and
`agent.service.launch()` spawns the provider CLI in it — optionally wrapped into a
`docker exec` for containerized builders (decision 011 / #133-#140). Parallelism is
therefore bounded by one host: its CPU, its RAM, and its single set of provider
credentials.

Three forces pushed past that:

1. **Throughput.** WIP is capped by what one laptop can run. Idle machines nearby
   (a second dev box, a server) cannot contribute.
2. **Heterogeneity.** Some tickets want Linux + Docker; the board may be on Windows.
   Containerized builders solve part of this, but only where Docker is on the board host.
3. **Isolation.** A remote worker is a stronger boundary than a container on the same
   kernel, and keeps agent credentials on the machine that owns them.

The board stays **local-first and single-user** (decision 006 and the project's hard
constraints) — this is not a step toward multi-tenancy. A fleet is the user's own
machines, paired explicitly.

## Decision

**Workers dial the board (pull model), and remote-ness is confined to execution.**

### Pull, not push
A worker daemon (`agentic-kanban worker start`) registers over REST and then holds a
WebSocket open for assignments. Deliberately NOT the Docker-Swarm shape (manager dials
node), which needs discovery and inbound-reachable workers; a pull model lets a laptop
behind NAT join with nothing but the board URL and a pairing token.

### Placement is a transformation, not a new pipeline
The provider abstraction already separates *what to run* (`AgentLaunchConfig`) from
*where* — containerization is a pure function applied to a finished launch config right
before the single `spawn()`. Remote execution is the third arm of that same seam:

- `Placement = host | container | remote` decided in one policy step,
- `AgentExecutionService` (the interface extracted from `agent.service`) with a
  dispatching proxy that routes per session,
- the remote implementation ships the serializable launch spec to a worker and feeds
  the returned events into the SAME `AgentOutputCallback`.

So broadcast, session persistence, turn handling and exit classification are untouched
by where the agent ran. That was the design constraint: **one execution pipeline, three
placements** — not a parallel remote pipeline that would drift.

### Git: the board remains the source of truth
A remote worker cannot share the board's filesystem, so the board serves each project's
repo over **git smart HTTP** (its own token-authed listener, `git --stateless-rpc`). The
worker clones, works in its own checkout, and pushes to
**`refs/kanban/incoming/<branch>`** — a staging namespace; pushes to `refs/heads/*` are
refused at the protocol level, because feature branches are checked out in board-side
worktrees and a direct push would desync them. The board then **fast-forwards** the real
branch from the incoming ref, after which diff, review, conflict detection and merge run
completely unchanged.

Fast-forward ONLY. A diverged branch is reported and held, never force-updated — the
staging ref keeps the work recoverable instead of silently discarding one side.

### Security: separate listeners, not a defended API
The board's REST API has no auth; its defense is loopback binding. The fleet surfaces are
the exception because they must be reachable off-loopback, so they follow the existing
MCP-HTTP-bridge pattern rather than inventing one: a single-use, short-lived **pairing
token** mints a per-worker **bearer token**, stored only as a sha-256 hash and compared
with `timingSafeEqual`; the WS upgrade authenticates before upgrading. Board agent
credentials are NEVER sent to a worker — a worker authenticates its agent with its own
machine-local login.

**The worker-facing endpoints therefore live on their OWN listener** (`KANBAN_FLEET_PORT`),
serving `POST /api/workers/register`, `POST /api/workers/:id/heartbeat`, `GET
/ws/workers/:id` and health — and nothing else. The main app stays on `127.0.0.1`
permanently.

This was a correction. The first cut kept everything on one app and told operators to set
`KANBAN_HOST=0.0.0.0`, which does not defend anything — it publishes `delete_issue`,
`merge_workspace` and every transcript to the network with no credential, mitigated only
by a "trusted network only" note in the docs. A warning is not a control. Splitting by
**audience** (owner-only mint/list/revoke stay inward; worker-called endpoints go outward)
makes "the board API is not reachable from the network" a property of what is mounted
where, which a misconfiguration cannot quietly violate. The split is opt-in and additive:
the main app still serves the full surface on loopback, so same-machine workers are
unaffected.

## Consequences

**Good**
- Capacity scales by pairing machines; the monitor can schedule against fleet capacity.
- The board host stops being the execution bottleneck and the credential chokepoint.
- Every downstream board feature (review, merge, scorecards, transcripts) works on
  remote work with no changes, because only placement moved.

**Costs / risks accepted**
- Two network surfaces exist (fleet + git). Both are token-authed and each serves one
  narrow purpose, but they are real attack surface the loopback-only API does not have.
  Both are opt-in — an unconfigured board opens nothing.
- Live stdout during a socket gap is dropped (exit events are queued and delivered);
  full replay is deliberately out of scope.
- The worker keeps a per-project clone, trading disk for clone time.
- Placement policy is per project (`worker_dispatch_<id>`, `worker_labels_<id>`,
  `worker_dispatch_strict_<id>`) — three more preference keys in a codebase that already
  has provider-default drift problems. Strict mode exists precisely so "ran on the host
  instead" can never be silent.

## Alternatives rejected

- **Board dials workers (Swarm-like).** Requires inbound reachability and discovery;
  hostile to laptops and NAT for no gain at this scale.
- **A global API token enforced whenever the bind is non-loopback.** Simpler to implement
  than a second listener, but every consumer — the client UI, the CLI, the MCP server —
  would have to carry and rotate that token, which is a large surface to get wrong for a
  single-user local tool. Splitting listeners keeps all of them talking to an
  unauthenticated loopback API exactly as before.
- **Share a filesystem (SMB/NFS) instead of git transport.** Would avoid the git plumbing
  but re-introduces Windows path/permission fragility, is slow over a real network, and
  makes the board's worktree state remotely mutable. Git is already the app's transfer
  format.
- **Workers push straight to `refs/heads/*`.** Simpler, but a branch checked out in a
  board worktree cannot be moved safely from outside, and a bad push would corrupt that
  worktree's state. The incoming namespace makes the landing step explicit and checkable.
- **Force-update the branch on divergence.** Silently loses commits. Holding and
  reporting is the only defensible default.

## Implementation

Epic #184, delivered in four phases:

| Phase | Ticket | What |
|---|---|---|
| 0 | #185 | `AgentHandle` + `AgentExecutionService` + dispatch proxy (pure refactor) |
| 1a | #186 | `workers` table, pairing/worker tokens, `/api/workers` |
| 1b | #187 | Worker daemon CLI, WS protocol, event streaming |
| 1c | #5 | `RemoteAgentService` + placement policy (same-machine dispatch e2e) |
| 2 | #188 | Git smart-HTTP serving, worker checkouts, incoming-ref sync |
| 3 | #189 | Labels/capacity matching, strict mode + monitor gate, restart recovery, Workers UI |
| 3+ | — | Hang-watchdog parity for remote sessions; standalone `agentic-kanban-worker` binary; the fleet-listener split above |

Key modules: `services/agent-dispatch.service.ts`, `services/agent-remote.service.ts`,
`services/worker-{registry,connection,fleet}.service.ts`, `services/git-http.service.ts`,
`services/worker-remote-sync.service.ts`, `services/fleet-listener.service.ts`,
`worker/worker-{daemon,agent-runner,repo,cli}.ts`, `startup/worker-incoming-sweep.ts`,
`components/WorkerFleetPanel.tsx`.

## Operating it

```bash
# Board machine, cross-machine fleet only: expose the two token-authed listeners.
# NEVER KANBAN_HOST=0.0.0.0 — that publishes the unauthenticated board API.
KANBAN_FLEET_PORT=3003 KANBAN_GIT_HTTP_PORT=3002 pnpm dev

# On the board machine: mint a single-use pairing token (or use the Workers UI panel)
pnpm cli -- worker pair

# On the worker machine (needs only the board URL — no checkout, no board DB)
agentic-kanban worker start --board http://<board-host>:3001 --token <pairing-token> \
  --labels docker,linux --providers claude --max-concurrency 2

# A worker that shares the board's filesystem skips git transport entirely:
agentic-kanban worker start --board http://127.0.0.1:3001 --token <t> --shares-filesystem
```

Opt a project in with `worker_dispatch_<projectId>=true`; require capabilities with
`worker_labels_<projectId>=docker,linux`; forbid the host fallback with
`worker_dispatch_strict_<projectId>=true` (the monitor then reports the
`no_available_worker` skip reason instead of running locally).
