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

Landing is bound to an **assignment**, not to the namespace (correction, see below): a
git token names one worker, one project and one incoming ref, and the startup sweep lands
an incoming ref only when the DB holds a dispatch for that project + branch
(`sessions.workerId` + `workspaces.branch`). Fast-forward-only is not a defence on its own —
a pusher who authors a descendant of `main` satisfies it.

### Security: separate listeners, not a defended API
The board's REST API has no auth; its defense is loopback binding. The fleet surfaces are
the exception because they must be reachable off-loopback, so they follow the existing
MCP-HTTP-bridge pattern rather than inventing one: a single-use, short-lived **pairing
token** mints a per-worker **bearer token**, stored only as a sha-256 hash and compared
with `timingSafeEqual`; the WS upgrade authenticates before upgrading (Authorization
header only — a token in a query string would land in proxy logs). Board agent
credentials are NEVER sent to a worker — a worker authenticates its agent with its own
machine-local login. That is enforced, not merely intended: the remote launch spec's env
is built from an explicit ALLOWLIST of non-secret board wiring
(`server/src/lib/remote-spec-env.ts`), and the worker MERGES it over its own environment
so its login and paths win.

**Container placement deliberately does the opposite, and that is not an inconsistency**
(#267). `agent-provider/container-wrap.ts` forwards `ANTHROPIC_*` / `CLAUDE_*` wholesale
into the container, because a container runs on the SAME machine under the SAME owner as
a host launch — the agent inside needs the credentials, and it is exposed to nobody who
could not already read the host environment. The invariant is *"credentials never leave
their machine"*, not *"credentials are never forwarded"*; only `remote` crosses a machine
boundary, so only `remote` gets the allowlist projection. The trigger to revisit: if
container placement ever stops being local — a remote Docker host, a shared CI runner, or
a daemon owned by another user — that forwarding becomes a credential leak and must route
through the same projection (with a `sameMachine: true` allowlist) instead.

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
- Live stdout during a socket gap is dropped; full replay is deliberately out of scope.
  Exit/`assign_failed` events ARE queued and delivered on reconnect — but only within
  three limits worth stating, because the bare claim overpromises: the queue is
  in-memory in the daemon (a daemon restart loses it), it is capped at 200 messages
  (`PENDING_QUEUE_CAP`), and the BOARD gives up after `WORKER_RECONNECT_GRACE_MS` = 60 s,
  finalizing every session on that worker with a synthesized stderr + `exit(1)` while the
  agent is still running on the worker. So a gap under a minute is survivable and a longer
  one destroys the run rather than pausing it. That last part is a defect, not the intent.
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

## The listener split is not sufficient in dev mode (2026-08-20)

Everything above describes the board API as unreachable from the network because it binds
loopback. **In `pnpm dev` that guarantee does not hold**, and the fleet-port split is what
makes it easy to believe otherwise.

The Vite dev server binds `::` — dual-stack, every interface — on 5173, and proxies `/api`,
`/health` and `/ws` straight to the loopback API. So the moment a board is brought up for
cross-machine work, the unauthenticated API is published on every interface the machine has,
including the tailnet. Confirmed by fetching `http://<tailnet-ip>:5173/api/projects` from the
VPN address and getting the real project list back, repo paths included. `vite.config.ts` even
carries `allowedHosts: [".ts.net"]`, so Tailscale reachability was anticipated somewhere.

Nothing in the fleet design defends this: the leak is the dev CLIENT, not the API bind, and an
operator following the cross-machine runbook has no reason to look at the client at all.

**Mitigation today is `VITE_HOST=127.0.0.1`**, which restricts the dev client to loopback. It
belongs in the same command as `KANBAN_FLEET_HOST` — a cross-machine board should never be
started without it. The stronger fix (make the dev client refuse a non-loopback bind whenever a
fleet listener is configured, rather than relying on an operator remembering a third env var)
is not implemented.

## Getting the worker binary without a release (2026-08-20)

`agentic-kanban-worker` is a bin of the `agentic-kanban` package, so the runbook's install step
quietly assumed the registry copy matches this tree. It does not: **published 0.1.9 predates the
fleet epic and its bin map has no `agentic-kanban-worker` key**, so `npm i -g agentic-kanban`
succeeds and produces no worker binary. Pairing a machine blocked on a release nobody had made.

`scripts/pack-worker.mjs` is the fast track — build, pack, hand over the file, no publish. Two
details in it are load-bearing rather than cosmetic:

- It **refuses to pack** when the bin map lacks `agentic-kanban-worker`, because a
  silently worker-less tarball is indistinguishable from a broken install at the far end.
- It stamps a **`<version>-dev.<sha>` prerelease**. A plain `npm pack` here emits
  `agentic-kanban-0.1.9.tgz` — the registry's version string with different contents — and npm
  may resolve a cached 0.1.9 instead of the file it was handed, silently installing the OLD
  two-bin package. That failure looks exactly like "the binary is missing".

Publishing a real release remains the better fix for every future worker machine; the script is
what unblocks one today. The trap is worth remembering generally: **the version string is not
evidence of the contents** — the local tree and the registry both said 0.1.9.

## Security corrections (2026-08-06, #244-#248)

An adversarial review of the shipped epic found that four of the properties claimed above
were **not** true of the code — the docs were the aspiration, not the behaviour. All four
are now enforced with regression tests; the list is kept here because "the docs said the
opposite" is the part worth remembering.

| # | Claimed | Actually did | Now |
|---|---|---|---|
| #244 | "credentials never leave their machine" | serialized the board's whole `process.env` (incl. the selected profile's `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`, plus any inherited `GITHUB_TOKEN`/npm token) into every `assign`, over a plaintext socket, and the worker spawned the agent with it INSTEAD of its own env | spec env built from an allowlist (`remote-spec-env.ts`); the worker merges it OVER its own env. Board-host paths (`GRADLE_USER_HOME`) travel only to a `shares-filesystem` worker |
| #245 | strict dispatch means host execution "can never be silent" | strictness was honoured only while CHOOSING a worker; if the socket dropped before `assign`, the dispatch proxy caught the throw and ran the agent on the board host anyway | `strict` rides on the `Placement`; the proxy refuses the host fallback and fails the session with `NO_AVAILABLE_WORKER`. The no-branch / no-repoPath fallbacks refuse too |
| #246 | pushes are confined to a staging namespace | the startup sweep fast-forwarded ANY `refs/kanban/incoming/*` ref in ANY project onto `refs/heads/<name>` — so a pushed descendant of `main` + a board restart = unreviewed code on `main` | the receive guard allows only the ONE ref the token was issued for, and the sweep lands only refs with a matching DB dispatch; unmatched refs are held and reported |
| #247 | "the worker's token stops working immediately" on revoke | ONE board-wide, per-boot git token granted full clone of EVERY project and outlived `revokeWorker`; the live WebSocket also stayed open | per-assignment tokens scoped to (worker, project, incoming ref) with a TTL, dropped on revoke; `revokeWorker` fires listeners that close the socket and invalidate the tokens |
| #248 | capacity scheduling respects `maxConcurrency` | load was derived from worker EVENTS, so an `assign` counted as zero until the agent's first output and three placements in a row could pile onto a `maxConcurrency=1` worker | a delivered `assign` occupies a slot immediately (expiring pending set, reconciled against `hello`) |

Two smaller items from the same review: the worker no longer embeds the token in the clone
URL (it was persisted in the clone's `.git/config` and visible in a process listing — it now
travels per invocation via `GIT_CONFIG_*`/`http.extraHeader`), and the receive-guard pkt-line
parser now requires canonical `[0-9a-f]{4}` lengths instead of trusting `parseInt`.

## Operating it

The operator-facing chapter — pairing, labels, strict dispatch, "nothing dispatches", the
traps — is [docs/worker-fleet.md](../worker-fleet.md). What follows is the minimum.

```bash
# Board machine, cross-machine fleet only: expose the two token-authed listeners.
# NEVER KANBAN_HOST=0.0.0.0 — that publishes the unauthenticated board API.
# VITE_HOST is not optional in dev — see "The listener split is not sufficient" above.
KANBAN_FLEET_PORT=3003 KANBAN_GIT_HTTP_PORT=3002 VITE_HOST=127.0.0.1 pnpm dev

# On the board machine: mint a single-use pairing token (or use the Workers UI panel).
# --board defaults to the loopback API port; `pair` is an OWNER endpoint and exists
# only there, so this command cannot be run from a worker machine.
pnpm cli -- worker pair

# On the worker machine (needs only the board URL — no checkout, no board DB).
# --board is the FLEET port: register, heartbeat and the assignment WebSocket are all
# served there, and the API port binds 127.0.0.1 so it is unreachable from here.
agentic-kanban-worker start --board http://<board-host>:3003 --token <pairing-token> \
  --labels docker,linux --providers claude --max-concurrency 2

# Back on the board machine: confirm the fleet's own view (also an owner endpoint).
pnpm cli -- worker list

# A worker that shares the board's filesystem skips git transport entirely. Same
# machine, so the loopback API port is the right --board here.
agentic-kanban worker start --board http://127.0.0.1:3001 --token <t> --shares-filesystem
```

Opt a project in with `worker_dispatch_<projectId>=true`; require capabilities with
`worker_labels_<projectId>=docker,linux`; forbid the host fallback with
`worker_dispatch_strict_<projectId>=true` (the monitor then reports the
`no_available_worker` skip reason instead of running locally).

**Do not put a path-based reverse proxy in front of the git transport** (`tailscale serve`,
an nginx `location` prefix). `composeGitUrl` (`worker/worker-repo.ts`) rebuilds the clone
URL as `scheme://<board-hostname>:<gitPort>/git/<projectId>` — it keeps only the *hostname*
from `--board`, discards any path prefix, and substitutes the port the board announced. The
clone then hangs with no visible cause. Use the machine's own name/address with the ports
directly; Tailscale Funnel must never be used at all.

### `worker list` is board-only (correction, 2026-08-22)

An earlier version of this section showed `--board http://<board-host>:3001` for
`worker start`, which is the API port and unreachable from another machine, and the
`worker instructions` runbook still marks its verification step as runnable from either
machine. Neither is true. The owner endpoints — `POST /api/workers/pairing-token`,
`GET /api/workers`, `DELETE /api/workers/:id` — are registered by `registerOwnerRoutes`
and mounted only on the loopback board app; the fleet listener is handed
`createFleetWorkersRoute`, which registers `registerWorkerFacingRoutes` and nothing else.
So `worker list` against the fleet port is a 404, and against the API port it cannot
connect at all.

From a worker machine the available checks are: `/health` (or `/api/health`) on the fleet
port, the daemon's own `[worker] connected to …` / `registered with …` log lines, and on
Windows `ak-worker-service.ps1 -Status`, which derives its state from the log tail for
exactly this reason. A token-authed `GET /api/workers/me` on the fleet listener plus a
`worker status` verb would close the gap; neither is implemented.
