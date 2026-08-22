# Worker fleet — operator manual

How to run agent sessions on machines other than the board's. This is the operating
chapter: pairing, labels, strict dispatch, the two network listeners, what to check
when nothing dispatches, and the two traps that fail with no visible cause.

The design record — why a pull model, why two listeners, why git transport — is
[decisions/012-worker-fleet-compute-model.md](decisions/012-worker-fleet-compute-model.md).
The CLI ships the same setup steps with your board URL filled in
(`agentic-kanban-worker instructions --board <fleet-url>`), generated from
`buildWorkerConnectSteps` so the runbook and the code cannot drift.

> **Why this is a separate file.** `docs/user-manual/USER-MANUAL.md` is generated
> (`.claude/skills/user-manual/user-manual.mjs`) — `create`/`update` rewrite the whole
> file from the section list in `section-map.json`, so a hand-written chapter inside it
> would be silently dropped on the next regeneration. The manual links here instead.
> Making the fleet a generated section of the manual is not done.

---

## 1. Which command runs where

This is the most common way to get stuck, so it comes first. **Three of the `worker`
verbs talk to the board's *owner* surface and only work on the board machine.**

| Command | Runs on | Endpoint it calls | Why |
|---|---|---|---|
| `worker pair` | **board machine only** | `POST /api/workers/pairing-token` | Owner route. Mounted only on the loopback board app (`registerOwnerRoutes`, `packages/server/src/routes/workers.ts`). |
| `worker list` | **board machine only** | `GET /api/workers` | Same — an owner route. |
| Revoke (`DELETE /api/workers/:id`) | **board machine only** | — | Same. |
| `worker start` | worker machine | `POST /api/workers/register`, `POST /api/workers/:id/heartbeat`, `GET /ws/workers/:id` | Worker-facing routes; each authenticates for itself, so these are the only ones exposed off-loopback. |
| `worker instructions` | anywhere | none | Pure text generation. |
| `--version` | anywhere | none | Reads the installed `package.json`. |

**`worker list` cannot be run from a worker machine.** Pointed at the fleet port it
returns 404 — the fleet listener mounts `createFleetWorkersRoute`, which registers only
the worker-facing subset (`server-start.ts` passes `createFleetWorkersRoute`;
`routes/workers.ts` builds it from `registerWorkerFacingRoutes` alone). Pointed at the
board's API port it cannot connect at all from another machine, because that app binds
`127.0.0.1` and stays there. There is no `worker status` verb and no
`GET /api/workers/me`; adding one is unimplemented.

**What a worker-side operator can actually check**, in order of usefulness:

1. **Reachability** — `curl -s -o /dev/null -w "%{http_code}\n" <fleet-url>/health`.
   The fleet listener answers both `/health` and `/api/health` unauthenticated, on
   purpose, so one instruction works against either port.
2. **The daemon's own log.** On a successful connect it prints
   `[worker] connected to <board-url>`; at registration it prints
   `[worker] registered with <board-url> as '<name>' (id=<workerId>)`, and on a later
   run `resuming pairing with …`. That line, plus the absence of reconnect-backoff
   lines, is the worker-side equivalent of "online".
3. **Windows service state** — `.\ak-worker-service.ps1 -Status` (shipped in the
   package under `tools/worker-windows`). It derives connection state from the log
   tail precisely because, as its own comment says, "this machine genuinely cannot ask
   the board how it looks from there."

To see the fleet's own view — status, labels, capacity — look on the board: `worker list`
there, or the UI (command palette → **Worker Fleet**).

## 2. `--board` — which port

`--board` for `worker start` must be the **fleet** port on a cross-machine setup.
Everything the daemon does with that URL lands on the fleet listener:

- `POST <board>/api/workers/register`
- `POST <board>/api/workers/:id/heartbeat`
- `ws(s)://<board>/ws/workers/:id`

The board's API port would serve all of these too — but only over loopback, so it is
unreachable from another machine by construction, not by convention.

| Situation | `--board` for `worker start` | `--board` for `worker pair` |
|---|---|---|
| Worker on another machine | `http://<board-host>:<KANBAN_FLEET_PORT>` | `http://127.0.0.1:3001` (run it on the board) |
| Worker on the board machine | `http://127.0.0.1:3001` also works — the loopback app serves the full surface | `http://127.0.0.1:3001` |

So on a cross-machine fleet the two commands take **different** `--board` values. The
CLI's default (`http://127.0.0.1:3001`) is the same-machine case.

Known drift, not yet fixed: the `agentic-kanban-worker --help` examples and the Worker
Fleet UI panel still print a bare `--board <board-url>` / `:3001` without saying which
port, and the `fleet-worker` skill's verification step still says `worker list` from the
worker machine. Those are strings in source, tracked separately from this page.

## 3. Pairing a machine

```bash
# 1. Board machine — mint a single-use token (expires in 10 minutes)
agentic-kanban worker pair

# 2. Worker machine — prerequisites: git on PATH, and the provider CLI installed
#    AND logged in HERE. The board never sends credentials.
git --version
claude --version        # or codex / copilot

# 3. Worker machine — start the daemon (foreground; Ctrl+C stops it)
agentic-kanban-worker start --board http://<board-host>:3003 --token <pairing-token> \
  --name "$(hostname)" --labels docker,linux --providers claude --max-concurrency 2

# 4. Board machine — confirm the board sees it
agentic-kanban worker list
```

The pairing token is exchanged for a per-worker bearer token stored in
`~/.agentic-kanban/worker-state.json`, so later runs need no `--token`. Do not hand-edit
that file — to re-pair, revoke the worker on the board and start again with a fresh token.

`agentic-kanban-worker` is the standalone binary for machines with no board: it loads
only the daemon and never opens or creates a database. On a machine that also runs the
board, `agentic-kanban worker <cmd>` is equivalent. `--version` reports the version from
the installed manifest, so it is usable evidence of which build is installed (it was
hardcoded to `0.0.1` in an earlier build; that is fixed).

Windows, unattended: the package ships `tools/worker-windows/ak-worker.ps1` (install /
replace / remove from a tarball) and `ak-worker-service.ps1` (register the
`AgenticKanbanWorker` scheduled task, with a supervisor and a tray indicator).

## 4. Labels, providers, capacity

Four things a worker advertises at `start`, all optional, all used by the board when it
picks a worker:

| Flag | Meaning | Matching rule |
|---|---|---|
| `--labels docker,linux` | Capabilities this machine has | A project's `worker_labels_<projectId>` must be a subset of these |
| `--providers claude,codex` | Agent CLIs installed and logged in here | The launch's provider must be in the list. **Absent or empty = "any"** |
| `--max-concurrency 2` | How many sessions this machine will take | Enforced on both sides: the board counts a delivered `assign` as an occupied slot immediately, and the worker enforces its own ceiling rather than trusting the assigner |
| `--shares-filesystem` | This worker sees the board's disk (same machine) | Skips git transport; the agent runs in the board's own worktree. Wrong across machines |

Capabilities are captured at first registration. Changing `--labels`/`--providers` later
does not update the board's record — revoke and re-pair to change them.

A worker reads `offline` once its heartbeat is older than 90 s
(`WORKER_HEARTBEAT_STALE_MS`); the daemon heartbeats every 30 s.

## 5. Opting a project in, and strict dispatch

Registration alone routes nothing. Per project:

```bash
agentic-kanban preferences set worker_dispatch_<projectId> true
agentic-kanban preferences set worker_labels_<projectId> docker,linux    # optional
agentic-kanban preferences set worker_dispatch_strict_<projectId> true   # optional
```

- **`worker_dispatch_<projectId>`** — without `true`, every launch is placed on the host.
- **`worker_labels_<projectId>`** — required capabilities; a worker that did not advertise
  them is not a candidate.
- **`worker_dispatch_strict_<projectId>`** — forbids the host fallback. Every path that
  would otherwise "quietly run it here" instead raises `NO_AVAILABLE_WORKER`, and the
  monitor skips the start with the reason `no_available_worker`. Strictness rides on the
  `Placement` object, so it is still honoured by the dispatch proxy's own catch — which
  runs long after placement was decided, when a worker vanishes between placement and
  `assign`.

**Strict dispatch and the profile allowlist are mutually exclusive on one project.** A
project with a non-empty (or unreadable) `allowed_profiles_<projectId>` never goes remote:
a worker authenticates the agent with its own local login and the board deliberately sends
no credentials, so the board can pick a permitted profile but cannot make the worker honour
it. `resolveWorkerPlacement` checks this *before* selecting a worker, so a strict project
holds with the restriction as the reason rather than with a capacity message. Worker-side
profile attestation would narrow this from "never" to "only to a worker that can prove it
qualifies" — that is not implemented.

## 6. The two network listeners

The board API has **no authentication**; its defence is that it binds `127.0.0.1`, and it
stays there. A cross-machine fleet opens two separate, narrow, bearer-authenticated
listeners instead:

```bash
# Board machine. NEVER KANBAN_HOST=0.0.0.0 — that publishes the unauthenticated board API.
KANBAN_FLEET_PORT=3003 KANBAN_GIT_HTTP_PORT=3002 VITE_HOST=127.0.0.1 pnpm dev

# VPN-only: bind both listeners to the VPN address instead of every interface
KANBAN_FLEET_PORT=3003 KANBAN_FLEET_HOST=100.x.y.z \
KANBAN_GIT_HTTP_PORT=3002 KANBAN_GIT_HTTP_HOST=100.x.y.z \
VITE_HOST=127.0.0.1 pnpm dev
```

| Variable | Serves | Default |
|---|---|---|
| `KANBAN_FLEET_PORT` | Worker register / heartbeat / WebSocket, plus `/health` and `/api/health`. Nothing else | **Unset = disabled.** No port is opened |
| `KANBAN_GIT_HTTP_PORT` | The git smart-HTTP transport only | **Unset = an OS-assigned port**, i.e. a different one every board boot. A cross-machine fleet must pin it — no firewall rule can match a port that moves |
| `KANBAN_FLEET_HOST` / `KANBAN_GIT_HTTP_HOST` | Which interface each binds | Unset = `0.0.0.0`, every interface |

The board API is never mounted on either listener, so "unreachable from the network" is a
property of what is mounted where rather than a warning a misconfiguration can violate. A
fleet still belongs on a trusted network (LAN / VPN / Tailscale), not the open internet.

**`VITE_HOST=127.0.0.1` is mandatory in `pnpm dev`.** The Vite dev server binds `::` —
every interface — and proxies `/api`, `/health` and `/ws` straight through to the loopback
API. Without it, bringing a board up for cross-machine work publishes the unauthenticated
API on every interface the machine has, including the tailnet; this was confirmed by
fetching the real project list from a VPN address on port 5173. The listener split does not
defend against it, because the leak is the dev *client*, not the API bind. Making the dev
client refuse a non-loopback bind while a fleet listener is configured is not implemented —
today it is an env var an operator has to remember.

## 7. Nothing dispatches — what to check

In the order the code decides it (`resolveWorkerPlacement`,
`packages/server/src/services/worker-fleet.service.ts`). In non-strict mode each of these
is a **silent host fallback** with a `[worker-fleet]` warning in the server log; in strict
mode each becomes a refusal the monitor reports as `no_available_worker`.

1. **`worker_dispatch_<projectId>` is not `true`.** Everything runs on the host, with no
   log line at all — this is the quietest of the five.
2. **The project has a profile allowlist.** `allowed_profiles_<projectId>` non-empty or
   unparseable → never remote (§5).
3. **No eligible worker.** All of these must hold, and any one of them failing looks
   identical from the outside:
   - the worker's `effectiveStatus` is `online` — heartbeat newer than 90 s;
   - the board still holds its WebSocket (`isConnected`) — a worker whose heartbeat is
     fresh but whose socket dropped is not a candidate;
   - the launch's provider is in the worker's `--providers` (empty list = any);
   - `worker_labels_<projectId>` ⊆ the worker's `--labels`;
   - it has a free slot against `--max-concurrency` (least-loaded worker wins).
4. **No branch to push back.** A true remote worker needs git transport, and a workspace
   with no feature branch has nothing safe to land — host.
5. **The project has no `repoPath`.** Nothing to serve over git transport — host.

A worker carrying the `shares-filesystem` label skips 4 and 5 entirely.

## 8. Two traps that fail with no visible cause

**A path-based reverse proxy in front of the git transport.** The worker composes its
clone URL as `scheme://<board-hostname>:<gitPort>/git/<projectId>` — from the *hostname*
of `--board` plus the port the board told it (`composeGitUrl`,
`packages/server/src/worker/worker-repo.ts`). Any path prefix in `--board` is discarded and
the port is substituted, so behind `tailscale serve` or an nginx `location` prefix the
clone simply hangs. Use the machine's own name or address (MagicDNS is fine) with the ports
directly. **Tailscale Funnel must never be used** — that is the public internet in front of
a board.

**A version string is not evidence of the contents.** `agentic-kanban-worker` is a bin of
the `agentic-kanban` package, and the published release can predate the fleet epic — the
install then succeeds and the binary is simply absent. Check `npm view agentic-kanban bin`
before relying on the registry; otherwise build a tarball on the board machine with
`node scripts/pack-worker.mjs`, which refuses to pack a tarball whose bin map lacks the
worker and stamps a `<version>-dev.<sha>` prerelease so npm cannot serve a cached
same-version copy in its place.

## 9. How work travels, and what survives a disconnect

The board serves each project's repo over token-authed git smart HTTP. A worker clones it,
runs the agent in its own checkout, and pushes to `refs/kanban/incoming/<branch>`; pushes
to `refs/heads/*` are refused at the protocol level, because those branches are checked out
in board-side worktrees. The board then **fast-forwards** the real branch from the incoming
ref, after which diff, review, conflict detection and merge run unchanged. A diverged
branch is held and reported, never force-updated.

Git tokens are per assignment — scoped to one worker, one project and one incoming ref,
expiring, and invalidated by revoke (which also closes the worker's live socket).

**Losing the socket does not kill agents.** The daemon keeps them running, reconnects with
backoff, re-announces them with `hello`, and queues `exit` / `assign_failed` messages while
offline so session finalization is not lost. The limits of that, precisely:

- Live stdout/stderr during a gap is **dropped** — no replay, deliberately.
- The queue is in-memory and capped at 200 messages (`PENDING_QUEUE_CAP`). A daemon
  *restart* loses it.
- The board waits `WORKER_RECONNECT_GRACE_MS` (60 s). Past that it finalizes every session
  on that worker with a synthesized stderr line and `exit(1)` — even though the agent is
  still running on the worker. A gap longer than a minute therefore destroys the run rather
  than pausing it. That is a known defect, not intended behaviour.

## 10. Reference

- Design record: [decisions/012-worker-fleet-compute-model.md](decisions/012-worker-fleet-compute-model.md)
- Environment variables: [env-vars.md](env-vars.md)
- Generated runbook: `agentic-kanban-worker instructions --board <fleet-url>` (add `--json`
  for the same steps machine-readable)
- Board-side modules: `services/worker-{registry,connection,fleet}.service.ts`,
  `services/agent-{dispatch,remote}.service.ts`, `services/git-http.service.ts`,
  `services/fleet-listener.service.ts`, `startup/worker-incoming-sweep.ts`
- Worker-side modules: `worker/worker-{cli,daemon,agent-runner,repo}.ts`
