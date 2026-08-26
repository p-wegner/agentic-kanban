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
| `worker explain` / `worker placements` / `worker events` | **board machine only** | `GET /api/workers/explain`, `/placements`, `/:id/events` | Owner routes. |
| `worker doctor-board` | **board machine only** | `GET /api/workers` | Owner route — that is exactly why it is a separate command from `worker doctor`. |
| `worker doctor` | worker machine | `/health`, `POST /api/workers/:id/heartbeat`, `GET /ws/workers/:id` | Worker-facing routes plus local checks (git, provider CLI, provider login). |
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

0. **`agentic-kanban worker doctor --board <fleet-url>`** (#774) — the whole chain this
   side can prove, in one command: fleet port reachable, the SAVED PAIRING still
   authenticates (a `worker list` cannot tell you this from here), the WebSocket upgrade
   survives whatever sits between the machines, the git transport port answers
   (`--git-port`), git on PATH, and each provider CLI installed **and logged in here**.
   Exits non-zero on any failure, so it is usable from the Windows scheduled task.
   Add `--json` for the report as data.
   It reports `pass` / `fail` / `skip` / `unknown` and never dresses an indeterminate
   result as a pass — a provider login can be inferred from its auth files but not proven
   without spending a request, and an API key in the environment is invisible to it.
   The board-side half is a SEPARATE command, `worker doctor-board`, run on the board:
   see the constraint this whole section is about.
1. **Reachability** — `curl -s -o /dev/null -w "%{http_code}\n" <fleet-url>/health`.
   The fleet listener answers both `/health` and `/api/health` unauthenticated, on
   purpose, so one instruction works against either port. (`worker doctor` runs this as
   its first check, so the raw curl is now the fallback rather than the instruction.)
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

# 4. Worker machine — self-test the whole chain from here (#774)
agentic-kanban worker doctor --board http://<board-host>:3003 --providers claude

# 5. Board machine — confirm the board sees it, and that it is actually PICKABLE
agentic-kanban worker list
agentic-kanban worker doctor-board
```

Step 4 and step 5 are deliberately two commands: §1 explains why neither machine can
answer for the other. The state they exist to separate is a worker whose heartbeat is
fresh but whose WebSocket the board does not hold — it looks online in `worker list`, is
never picked, and only `doctor-board` names it.

The pairing token is exchanged for a per-worker bearer token stored in
`~/.agentic-kanban/worker-state.json`, so later runs need no `--token`. Do not hand-edit that
file — to re-pair, revoke the worker on the board and start again with a fresh `--token`. That
advice **now actually works** (#754): the daemon drops the stale pairing itself on the first
401, which is what made it impossible before — the same line told you to re-pair with a token
that "is ignored once paired".

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

Capabilities ride **every heartbeat**, not just the first registration (#754), so changing
`--labels` / `--providers` / `--max-concurrency` and restarting the daemon updates the board
within one beat — no revoke-and-re-pair. Before that fix they travelled only at registration,
which the daemon SKIPS once paired: re-running `start --labels docker --max-concurrency 4`
changed nothing on the board while the local runner enforced the new ceiling, so board and
worker silently disagreed about the same machine (and `ak-worker-service.ps1 -Install` wrote
the flags to `config.json` as if reinstalling had applied them).

A capability the worker does not pass is left **unchanged**, not cleared: no `--labels` means
"saying nothing about labels", not "I have none".

A worker reads `offline` once its heartbeat is older than 90 s
(`WORKER_HEARTBEAT_STALE_MS`); the daemon heartbeats every 30 s.

`worker list` on the board shows each worker's `protocol=` and `build=` — the protocol it
last reported and its package version. `?` means it has not heartbeated since this board
process started (the values are held in memory, not in a column), not that it is old.

## 5. Opting a project in, and strict dispatch

> **There is a UI for this now (#774).** Command palette → **Worker Fleet** → *Remote
> dispatch* sets `worker_dispatch_<projectId>`, `worker_dispatch_strict_<projectId>` and
> `worker_labels_<projectId>` for the board's active project. Before that, the three keys
> were declared in `dynamic-preference-keys.ts` and referenced by no client code, so
> opting a project in was a curl — while the panel's "Pair a new worker" button implied
> the flow was complete.

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

**The same is true of a data-handling requirement (#876).** `required_data_labels_<projectId>`
(a CSV of tags such as `no-training`, `eu-data-residency`) names a property a launch's
resolved *profile* must carry — set per profile via `profile_capabilities_<provider>:<name>`.
A fleet worker cannot prove which profile tags the account it authenticates as actually
carries any more than it can prove which allowlisted profile it is using, so a project with
this requirement set never goes remote either, for exactly the same reason and checked
immediately after the allowlist (§7 below). The local (host) half of this mechanism IS
enforced: `resolveProviderConfig` holds a launch with `DATA_HANDLING_REQUIREMENT_HOLD` when
the resolved profile is untagged or missing a required tag.

## 6. The two network listeners

The board API has **no authentication**; its defence is that it binds `127.0.0.1`, and it
stays there. A cross-machine fleet opens two separate, narrow, bearer-authenticated
listeners instead:

```bash
# Board machine. NEVER KANBAN_HOST=0.0.0.0 — that publishes the unauthenticated board API.
KANBAN_FLEET_PORT=3003 KANBAN_GIT_HTTP_PORT=3002 VITE_HOST=127.0.0.1 pnpm dev

# Cross-machine, VPN-only: name the interface. This is the intended posture --- without
# a named interface (or KANBAN_FLEET_INSECURE=1) both listeners stay on loopback.
KANBAN_FLEET_PORT=3003 KANBAN_FLEET_HOST=100.x.y.z \
KANBAN_GIT_HTTP_PORT=3002 KANBAN_GIT_HTTP_HOST=100.x.y.z \
VITE_HOST=127.0.0.1 pnpm dev
```

| Variable | Serves | Default |
|---|---|---|
| `KANBAN_FLEET_PORT` | Worker register / heartbeat / WebSocket, the allowlisted board-MCP bridge at `/mcp` (section 11), plus `/health` and `/api/health`. Nothing else | **Unset = disabled.** No port is opened |
| `KANBAN_GIT_HTTP_PORT` | The git smart-HTTP transport only | **Unset = an OS-assigned port**, i.e. a different one every board boot. **Required once `KANBAN_FLEET_PORT` is set** — see the invariant below |
| `KANBAN_FLEET_HOST` / `KANBAN_GIT_HTTP_HOST` | Which interface each binds | **Unset = `127.0.0.1`** (#753). Naming the interface is how a listener leaves this machine |
| `KANBAN_FLEET_INSECURE` | Nothing on its own. `=1` lets an unset host mean every interface again | Unset. Only the exact value `1` counts — `true` does not |

**INVARIANT: a configured fleet listener requires a PINNED `KANBAN_GIT_HTTP_PORT` (#776).**
A worker receives `gitPort` exactly once, in its `assign` frame, and rebuilds every clone and
push URL as `scheme://<host>:<gitPort>/git/<projectId>` for the life of that assignment. With
`KANBAN_GIT_HTTP_PORT` unset the port is OS-assigned on every boot, so a board restart — or
any relisten — silently invalidates a value a worker is still using: its push lands on some
unrelated service, or on nothing, and the failure has no visible cause on either side. The
git transport therefore **refuses to start** on an OS-assigned port while `KANBAN_FLEET_PORT`
is set, and says why:

```
[git-http] refusing to start the git transport on an OS-assigned port while a fleet
listener is configured (KANBAN_FLEET_PORT=3003). ... Set KANBAN_GIT_HTTP_PORT to a pinned
port (see docs/worker-fleet.md section 6).
```

It surfaces as ONE failed git-transport dispatch, not a board that will not boot: the
transport is started lazily by the first such dispatch, and a `--shares-filesystem` worker
never reaches it at all. The alternative considered — re-announcing the current git port to
connected workers on listener start — was rejected because it fixes the stale-value symptom
and not the cause: a remote worker reaches this listener through a firewall/NAT rule, and no
rule can match a port that moves every boot, so the re-announced number would be accurate and
still unreachable.

The board API is never mounted on either listener, so "unreachable from the network" is a
property of what is mounted where rather than a warning a misconfiguration can violate.

**Unset used to mean every interface, and no longer does (#753).** The old default was
chosen as "no behaviour change for anyone", but it meant that pinning a fleet port — the one
thing a cross-machine setup must do — silently published a plaintext credential-bearing
channel on every network the board machine happened to be attached to: office LAN, home LAN,
hotel wifi. If a worker suddenly cannot connect and the board log says `binding 127.0.0.1:
this listener is plaintext and no interface was named`, that is this change: name the
interface, or set `KANBAN_FLEET_INSECURE=1` if every interface is genuinely what you want.
The direction is deliberate — the old default could only be too wide, and the new one fails
visibly.

### Threat model: everything here is plaintext

Both listeners are plain HTTP and neither supports TLS today. What that means concretely,
because "keep it on a trusted network" is too vague to act on:

| In the clear on the wire | If an attacker can READ it | If an attacker can WRITE it |
|---|---|---|
| The per-worker bearer token (every heartbeat, and the WS upgrade) | Impersonate that worker: take its assignments, stream fabricated output into its sessions | — |
| The per-assignment git token (in the `assign` frame, then `Authorization: Basic` on every git request) | Clone that one project, for as long as that assignment is current | Push a chosen tree to that branch's incoming ref |
| Repo contents, both directions | Source disclosure | — |
| The board-authored `setupScript` inside the `assign` frame | — | **Arbitrary code execution on the worker machine**, as the worker's user |

The last row decides the posture: this is not merely a confidentiality-sensitive transport,
it is an **RCE channel into every worker** for anyone who can inject frames. So:

- **A fleet belongs on a tailnet or a VPN** — a network whose peers are cryptographically
  identified by something other than this board. Tailscale/WireGuard supplies exactly the
  encryption and peer authentication this transport does not have.
- **A plain LAN is not sufficient** for that last row: traffic injection on wifi, or from one
  compromised host on a switched segment, is a real capability.
- **Tailscale Funnel must never be used** — that is the public internet in front of a board.
- **Do not put a TLS-terminating proxy in front of the git transport.** The worker rebuilds
  the URL itself and drops any path prefix (section 8), so such a proxy is bypassed rather
  than enforced.
- TLS on either listener is **not implemented**. Until it is, the network *is* the control.

The scoping in #247 / #246 / #753 bounds what a stolen *git* token is worth — one worker, one
project, one ref, and only while its dispatch is current. It does not make the channel
confidential, and it does nothing about the `setupScript` row.

**`VITE_HOST=127.0.0.1` is mandatory in `pnpm dev`.** The Vite dev server binds `::` —
every interface — and proxies `/api`, `/health` and `/ws` straight through to the loopback
API. Without it, bringing a board up for cross-machine work publishes the unauthenticated
API on every interface the machine has, including the tailnet; this was confirmed by
fetching the real project list from a VPN address on port 5173. The listener split does not
defend against it, because the leak is the dev *client*, not the API bind. Making the dev
client refuse a non-loopback bind while a fleet listener is configured is not implemented —
today it is an env var an operator has to remember.

### The board-MCP bridge shares this listener (#769)

`/mcp` on the fleet port is the board's own tool surface, narrowed to an allowlist and scoped
to one assignment. It is on this listener for the same reason everything else here is: it is
the only one that authenticates every request, and the board API must stay loopback-only. See
section 11 for what it grants and what it cannot.

## 7. Nothing dispatches — what to check

In the order the code decides it (`resolveWorkerPlacement`,
`packages/server/src/services/worker-fleet.service.ts`). In non-strict mode each of these
is a **silent host fallback** with a `[worker-fleet]` warning in the server log; in strict
mode each becomes a refusal the monitor reports as `no_available_worker`.

1. **`worker_dispatch_<projectId>` is not `true`.** Everything runs on the host, with no
   log line at all — this is the quietest of the seven.
2. **The project has a profile allowlist.** `allowed_profiles_<projectId>` non-empty or
   unparseable → never remote (§5).
3. **The project has a data-handling requirement.** `required_data_labels_<projectId>`
   non-empty → never remote, same reasoning as check 2 (#876, §5).
4. **No eligible worker.** All of these must hold, and any one of them failing looks
   identical from the outside:
   - the worker's `effectiveStatus` is `online` — heartbeat newer than 90 s;
   - the board still holds its WebSocket (`isConnected`) — a worker whose heartbeat is
     fresh but whose socket dropped is not a candidate;
   - the launch's provider is in the worker's `--providers` (empty list = any);
   - `worker_labels_<projectId>` ⊆ the worker's `--labels`;
   - it has a free slot against `--max-concurrency` (least-loaded worker wins).
5. **No branch to push back.** A true remote worker needs git transport, and a workspace
   with no feature branch has nothing safe to land — host.
6. **The project has no `repoPath`.** Nothing to serve over git transport — host.
7. **The repository shape does not fit the transport.** The board's git transport carries ONE
   repository per assignment, without LFS objects and without submodules, so a project with
   sibling repos, LFS or submodules is refused rather than dispatched against an incomplete
   checkout (#748). A layout that cannot be read at all fails closed the same way.

A worker carrying the `shares-filesystem` label skips 5, 6 and 7 entirely — it reads the
board's own worktrees, siblings and LFS objects included.

**Ask the board instead of reading this list.** `agentic-kanban worker explain <N>` (and
`GET /api/workers/explain?issue=<N>`) walks these same seven checks against live state and
names the one that decided, with the values it read (#755). The chain it walks is pinned to
`resolveWorkerPlacement`'s source order and to this section's numbering by
`placement-chain-parity.test.ts`, and every answer carries `agreesWithResolver` — so if the
explanation and the resolver ever disagree, the payload says so rather than guessing.

### 7a. What the board REMEMBERS about a worker (#774)

§7 answers "why is nothing dispatching **now**". It is evaluated when asked, so it is a
weak answer to "why did that session three days ago run on the host" — and the board used
to keep no history at all: a connect, a registration, a protocol mismatch and an
incoming-ref decision existed only as a `console.*` line on the board's stdout (and, on
Windows, the daemon's `-Log`). A restart discarded all of it, which is what made a
#699/#706-class failure a scrollback-archaeology exercise.

The board now keeps a per-worker timeline:

```bash
agentic-kanban worker events <workerId>          # newest first; --limit, --json
```

- REST: `GET /api/workers/:id/events` (owner route; `?limit=`, `?types=a,b`).
- UI: the **History** button on each row of the Worker Fleet panel.
- MCP: not exposed as its own tool — `list_workers` gives the ids, and the timeline is a
  read for an operator rather than something an agent decides on.

**What is recorded, and where each one is written.** #774 could emit four of the ten types;
#801 wired the other six, so the vocabulary and what the board actually writes are now the
same list:

| Type(s) | Written by |
|---|---|
| `registered`, `protocol_mismatch`, `ref_landed`, `ref_discarded` | `routes/workers.ts` |
| `connected`, `disconnected` | `services/worker-fleet.service.ts` |
| `assigned`, `session_exit` | `services/agent-remote-events.ts` |
| `ref_held` | `services/worker-incoming-refs.service.ts` |
| `status_change` | `services/worker-registry.service.ts` |

Two of those placements differ from the ones #801's ticket text predicted, for reasons worth
knowing. `connected`/`disconnected` are wired at the fleet's composition root rather than in
`fleet-listener.service.ts`, because the listener is only one of the two ways a worker
connects — a same-machine worker dials the board's main port, whose WebSocket route is built
from the same connection manager — and the composition root is the only place that sees both.
`status_change` is observed where the board COMPUTES effective status (`listWorkersView`)
rather than on the heartbeat, because the transition that matters after a failure is
`online -> offline`, which happens when a heartbeat STOPS arriving and so has no event of its
own. Only transitions are recorded, and a worker's first sighting seeds silently: a row per
30 s heartbeat would spend the whole per-worker retention budget on noise, and "the board
rebooted" is not a fact about the worker.

The split is still data (`EMITTED_TYPES` / `UNEMITTED_TYPES` in
`services/worker-events.service.ts`) and still pinned by
`worker-events-emitter-coverage.test.ts`, which fails in BOTH directions. `UNEMITTED_TYPES`
is empty today and is kept rather than deleted: an empty list plus the guard is what makes
the NEXT declared-but-unwired type a test failure instead of a silent false claim in the
panel's legend.

There is no `revoked` event, deliberately: revoking a worker DELETES its whole timeline, so
such a row would be written and dropped in the same breath.

**Retention.** Capped per worker at 300 rows, pruned oldest-first on the write path — so
the table's ceiling is `registered workers x 300` and does not grow with fleet traffic. The
bound is on the write path rather than in a sweep because #738 happened with a retention
service already in the codebase (99,140 issue comments, 127 MB of a 186 MB database).

### 7b. The fleet from MCP (#774)

Five tools, each a thin pass-through to the REST endpoints above, so an agent asked to
diagnose the fleet does not hand-roll curl against a port it has to guess:

| Tool | Answers |
|---|---|
| `list_workers` | the fleet with LIVE state — connected, load, real free slots, per-worker eligibility and why not |
| `explain_worker_placement` | §7's ordered chain for one issue (or the project), with `agreesWithResolver` |
| `mint_worker_pairing_token` | a single-use pairing token plus the command to run on the other machine |
| `revoke_worker` | revoke by id |
| `list_incoming_refs` | the held-ref staging inventory of §9 |

`get_fleet_friction` is an **unrelated** tool whose name collides — it aggregates agent
tool-call friction and has nothing to do with worker machines.

### 7c. Why did THAT session run where it did? (#801)

§7 re-derives the chain against LIVE state and §7a records what the FLEET looked like at the
time. Neither answers "why did that session run on the board host last Tuesday", and a
re-derivation never can: the preferences, the fleet's membership and the project's repo shape
have all moved since.

So `resolveWorkerPlacement` now stamps its own verdict onto the decision it returns, and the
session lifecycle persists it on the session row (`sessions.placement_reason` +
`placement_detail`, migration 0133). The id is the same `PlacementCheckId` vocabulary §7 uses
— deliberately, so a historical record and a live explanation cannot disagree about what to
call a step — plus `resolver_error` for the catch-all host fallback, which is not a check.

```bash
agentic-kanban worker placements --limit 20
#   2026-08-23T09:12:04Z #801 claude [completed] on host
#       why: repo_transport_shape — project ... has submodules
```

Also on `GET /api/workers/placements` and in `explain_worker_placement`'s `sessions` array.

Both columns are NULLABLE and stay null for a session dispatched before this landed, and for
one whose placement was passed in explicitly rather than resolved — "not recorded" and "host
by default" have to stay distinguishable, so nothing is backfilled and nothing is defaulted.

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
same-version copy in its place. That build deliberately SKIPS the React client — a worker
never loads it, and a client-only breakage (a corrupt rollup binary in the pnpm store) used
to block packaging a worker entirely (#845). Pass `--with-client` when the tarball should
carry the UI too.

## 9. How work travels, and what survives a disconnect

The board serves each project's repo over token-authed git smart HTTP. A worker clones it,
runs the agent in its own checkout, and pushes to `refs/kanban/incoming/<branch>`; pushes
to `refs/heads/*` are refused at the protocol level, because those branches are checked out
in board-side worktrees. The board then **fast-forwards** the real branch from the incoming
ref, after which diff, review, conflict detection and merge run unchanged. A diverged
branch is held and reported, never force-updated.

Git tokens are per assignment — scoped to one worker, one project and one incoming ref,
expiring, and invalidated by revoke (which also closes the worker's live socket).

**And bound to a live dispatch (#753).** That scoping was complete in space and not in time:
nothing happened when a session ENDED, so a token's only bounds were its 24h TTL and an
explicit revoke. A token holder could clone the project and force-push a descendant of
`master` to the branch's incoming ref hours after review and merge had finished — and
because the startup sweep matched "any session ever stamped with a workerId for this
branch", the next board restart would fast-forward it. Both halves are now time-bound:

- **Every git request re-derives authority from the DB.** The dispatch behind the token must
  still be current: a session `running`, or ended within
  `WORKER_RESULT_LANDABLE_AFTER_END_MS` (1 hour, which covers a push in flight when the
  stale-session sweep finalizes the row at board startup). A token that fails is refused
  **and dropped**, so the holder cannot keep probing until some later session happens to
  make it valid again. One gap is left open deliberately: a token younger than 5 minutes is
  honoured even with no dispatch row at all, because `sessions.workerId` is stamped
  asynchronously *after* the assignment goes out and a fast clone legitimately beats that
  write.
- **`refs/kanban/incoming/*` is hidden from `upload-pack`.** A token authorised a full clone,
  whose ref advertisement included every *other* worker's unlanded result. A worker only ever
  fetches `refs/heads/*`, so hiding them costs nothing.
- **The startup sweep lands only a current dispatch**, and judges a recycled `ak-<N>` branch
  name by its *newest* dispatch rather than by any dispatch that ever wore the name. Anything
  else is held and reported — and `POST /api/workers/incoming/land` still lets an operator
  land it deliberately, keeping the looser "was ever dispatched" gate there on purpose: a
  human choosing one ref is a different act from a startup pass landing whatever it finds.

**The push path has real resource limits (#753), not just a ref check.** The receive-pack
guard buffered the command section with no cap of any kind, so an authenticated client could
stream never-completing pkt-lines and OOM the board process, taking every worktree agent on
the machine with it. Now: the command section is capped at 64 KiB and 64 lines; an empty
refname is refused (it used to skip the ref check entirely); one request body is capped at
1 GiB counted *after* gzip, so a compression bomb is bounded by the same number
(`KANBAN_GIT_MAX_BODY_BYTES` raises it); headers must arrive within 60 s and a request must
finish within 15 min; and a client that disconnects mid-push has its `git receive-pack`
killed rather than left holding a stdin nobody will ever close.

**The git credential is read from the Basic *password* slot only.** It used to be accepted as
the username too, so that pasting it the wrong way round still worked. That put a live token
in the half of a URL which gets echoed into `git remote -v`, proxy access logs and error
text, while the password half is the one every tool in that chain knows to redact.

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

### Mid-session, board-to-worker: the checkout is not write-once (#783, #784)

Everything above is the worker pushing at exit. Two board-to-worker operations act
**while the agent is still running**, and both are strictly fast-forward:

- **`sync_repo` (#783) — before a follow-up turn.** `POST /api/workspaces/:id/turn`
  first asks the worker to fast-forward its live checkout to the board's tip of the
  branch, and **refuses the turn** if that could not be done. It has to: between two
  turns the board may have rebased the branch (`update-base`), committed a
  fix-and-merge change, or landed a review fix — all of which exist only board-side.
  Without the sync the second turn rebuilds on the tree the session cloned, and the
  result is indistinguishable afterwards from the agent deliberately reverting the
  board's work. So a remote workspace used to be **one-shot in practice**, which
  quietly made every feature built on follow-up turns (nudges, fix-and-merge, monitor
  unstick, the review loop) host-only.
  - `409` — the worker's checkout has **diverged** (both sides committed), or a
    fast-forward would have had to overwrite the agent's **uncommitted** work. Held for
    a human; nothing is reset and nothing is forced.
  - `422` — the sync could not complete: the worker did not answer within the bound
    (a build predating these messages drops them), the socket is gone, or the board
    cannot see the worker at all. An `unknown` liveness HOLDS here — it is absence of
    information, not evidence that the checkout is fine.
  - A worker with the `shares-filesystem` label is skipped: it already works in the
    board's own worktree.
- **`push_head` (#784) — before a diff is read.** A true-remote worker used to push
  exactly once, post-exit, so the board-side worktree sat at the base tip for the whole
  run and `GET /api/workspaces/:id/diff` showed **nothing** until the agent finished.
  Now the diff asks the worker for its current HEAD, lands it through the one landing
  path (`syncIncomingBranch`, i.e. ref-arm then `merge --ff-only` in the holding
  worktree), and returns a `remoteMidSession` block saying what happened and how old
  it is.

**ON DEMAND, NOT ON A TIMER — the deliberate choice.** The session's branch is checked
out in a board worktree, so a landing moves that working tree: files change under
anything else reading it. A timer would do that at moments nothing asked for, to
workspaces nobody is looking at. Landing when a diff is REQUESTED keeps the movement
inside a read that already expects new content, makes the cost proportional to how
often anyone looks, and gives a fresher answer than any tick would. Repeat reads for
one workspace are throttled (`MID_SESSION_LAND_MIN_INTERVAL_MS`, 15 s) and the previous
landing is then reported **with its real age** rather than as a fresh result.

**Only COMMITTED work travels.** The worker will not commit on the agent's behalf, so a
mid-session diff shows what the agent has committed — not its working tree. A remote
agent that never commits until the end still shows nothing until the end.

**The board CARD does not get the landing, and says so instead (#790).** Two readers
compute the same numbers WITHOUT going through that route: the per-card diff-stat in
`board-status-enrichment.ts`, and the workspace summary's git projection (whose "HEAD
advanced → refresh the diff-stat" trigger never fires for a true-remote session, because
the board-side HEAD genuinely does not move). Both therefore read the base tip, and a
card showed a confident `+0 −0` for an agent that had been committing for twenty minutes.

Giving those two #784's on-demand landing was the other available answer and was
**rejected deliberately**: a board rebuilds every card in one pass, on a poll, including
the ones nobody is looking at — which is precisely the timer the section above argues
against, just reached through a different door. A card is not worth a git push per
refresh.

So the numbers stay as they are and the card gains the sentence that was missing. When a
branch belongs to a live git-transport session, the board attaches
`remoteUnlanded: { workerId, sessionId, label }` (`unlandedRemoteBranches`,
`worker-remote-sync.service.ts`) and the workspace card renders it as
**"remote — committed work not yet landed"**. The defect being fixed is not the zero —
it is the zero being **silently** wrong. Opening the diff still lands the work and shows
the real numbers.

The lookup is synchronous and reads only the in-memory session map, so it costs a board
build nothing; with no fleet in the process it yields an empty map and every card is
exactly as it was. A filesystem-sharing worker is never marked — it has nothing unlanded.
Branch names are the key, so two projects with the same branch name could over-warn; that
is an over-warning, never a wrong number.

**No new credential.** A mid-session operation carries a **fresh** token minted through
the existing `issueToken({workerId, projectId, incomingRef})` seam, because the
assignment's own token expires and a board restart invalidates it. It is a git
capability for one ref, and decision 012 is untouched: no provider login and no
`CLAUDE_CONFIG_DIR` crosses the machine boundary.

### Stopping a worker without losing work (#754)

**Ctrl+C now drains.** `worker start` waits for the results of agents it just killed to
finish pushing before the process exits, announces `draining` to the board first so no new
session is placed into a dying daemon, and prints what it saved:

```
[worker] shutting down
[worker] drained cleanly: 1 result push(es) completed
```

`--drain-timeout <seconds>` (default 30) bounds the wait; a second Ctrl+C exits immediately.
The exit code is 0 when nothing was lost and 1 when something was, so a supervisor can tell.

Before this, `stop()` was synchronous and the CLI called `process.exit(0)` straight after —
so with the agents killed the process was gone before their exit handlers could push, and a
**completed** agent's work was reported to the board as a failure 60 s later, via the
disconnect grace.

**What a drain can and cannot save.** Be precise about this, because the queue is the part
that looks safer than it is:

| Situation | Saved? |
|---|---|
| An agent finished, its push is in flight when you hit Ctrl+C | **Yes** — waited for, up to `--drain-timeout` |
| An agent finished, its push needs longer than the timeout | **No.** Reported as `pushes abandoned`, exit code 1. The commit is still in the worker's checkout under `~/.agentic-kanban/worker/checkouts/<sessionId>` |
| Queued `exit`/`assign_failed` frames, socket UP at shutdown | **Yes** — flushed before the socket closes |
| Queued frames, socket DOWN at shutdown | **No.** The queue is in memory only (cap 200) and dies with the process; the board falls back to its 60 s grace |
| More than 200 queued frames during a long outage | **No** — the excess was already dropped at enqueue time, before any shutdown |
| `--leave-agents`: an agent still running at exit | **No, and this is the trap.** The agent survives, but the mapping from session to checkout lives in the dead daemon's memory, so **no future daemon can push its result.** The runbook's "leaves them alive" is only true for same-filesystem workers; for a git-transport session the work is stranded on disk. The daemon now says so at exit |

Persisting the session→checkout mapping so a restarted daemon could adopt and push an
orphaned result is **not implemented**, and deliberately not a quick win: the push needs the
assignment's git token, and #753 just made that token die with its session — writing it to
disk would undo that. The fix is for a restarted daemon to ask the board for a fresh token
for a session it can prove it owns, which is a protocol addition.

**Planned restart, no loss:** there is no `worker drain` verb (it would need the worker's own
bearer token, which only the daemon has). A clean stop is `Ctrl+C` / `SIGTERM` — which
announces `draining` and waits — then start the new build.

### When a worker will never connect (#754)

Two failures used to look exactly like a bad network, and both now stop with a reason:

- **A 401** (revoked worker, or the board's DB was reset) is no longer retried every 30 s
  forever. With `--token` the daemon drops the stale pairing from `worker-state.json` and
  re-pairs — the recovery the runbook always described but the code could not perform,
  because that file blocked it. Without `--token`, or after `MAX_REPAIR_ATTEMPTS` (2), it
  **exits 2** and names the fix. A pairing token is single-use, so repeated rejection is not
  something another token cures.
- **A protocol mismatch** answers **409**, which the daemon treats as terminal rather than
  retryable, and the message says which side to upgrade. See below.

An unhandled error no longer takes the daemon down either: the entry installs
`uncaughtException`/`unhandledRejection` handlers that log and keep running, and every
agent's stdin has an `error` listener. An EPIPE there — an agent exiting before it drains a
large prompt, i.e. the runbook's own "starts then fails immediately" case — used to kill the
daemon and orphan **every other agent on the machine**, because an unhandled stream `error`
is a process-level uncaught exception.

### Protocol versions (#754)

The daemon and the board each state a protocol version (`WORKER_PROTOCOL_VERSION`), in
`register` and in every `hello` and heartbeat. Before this there was no version at all and an
unknown message type was dropped as "malformed", so board/worker skew — the normal case with
hand-copied dev tarballs — failed as a *silence*.

| The worker says | The board does |
|---|---|
| The current version | Accepts |
| **Nothing** (a build older than the handshake) | **Accepts.** It speaks exactly protocol 1, because protocol 1 *is* the wire format as it stood when the handshake was added. Refusing a machine that works, on a fleet where the worker is someone else's computer, would be a cost with no benefit |
| A version older than `MIN_SUPPORTED_WORKER_PROTOCOL_VERSION` | Refuses: 409, "UPGRADE THE WORKER", with the `pack-worker.mjs` command |
| A version newer than the board | Refuses: 409, "UPGRADE THE BOARD" |

The compatibility window closes on its own at the first real bump: raise `MIN_SUPPORTED` to 2
and every version-less worker is refused *then*, with a message naming the fix. A worker that
heartbeats an incompatible version is marked `offline` immediately, which is how the refusal
reaches the scheduler — `eligibleWorkers` already skips anything not effectively online, so no
dispatch path needs to know about versions.

A version column on `workers` (and the panel showing it) is **not implemented**; the values
live in board memory and are re-learned within 30 s of a restart.

## 11. Board tools on a worker — what a remote agent CAN and CANNOT do (#769, #799)

A remote builder used to have no `mcp__agentic-kanban__*` tools at all: the board's own
`--mcp-config` names a file in the board's tmpdir describing a stdio server that would open the
board's natively-compiled sqlite binding, so a true-remote launch spec strips the flag (#747).
#749 made the shipped brief HONEST about the absence. #769 removed it for the two providers that
can be pointed at a config file; **#799 added codex, the comment tool, and the per-request
assignment check that a write surface makes mandatory**.

**What is served.** `ALL /mcp` on the fleet listener, proxying the board's existing MCP HTTP
listener (#136) over loopback. Every request needs a **per-assignment** bearer token scoped to
`{workerId, projectId, sessionId}` — minted at dispatch, expiring, dropped when the session is
finalized and when the worker is revoked. It travels in a config file written into the worker's
checkout (`.mcp-kanban.json`, via the same `contextFiles` channel as the ticket brief), never in
argv, so no process listing on the worker shows it. Digest-only board-side, like every other
token here.

**The allowlist**, enforced by the proxy — not merely hidden from `tools/list`:

| Allowed | Refused (examples) |
|---|---|
| `get_issue`, `list_issues`, `get_board_status`, `create_issue`, `add_comment` | `merge_workspace`, `mark_ready_for_merge`, `close_workspace`, `set_preference`, `delete_*`, `start_workspace`, `relaunch_workspace`, every session/transcript reader |

`create_issue` is **pinned** to the assignment's project: a call with no `projectId` gets it
filled in (the default is the board's ACTIVE project, i.e. the classic misfile), and a call
naming another project is refused. The allowlist lives in one place —
`REMOTE_BOARD_TOOLS` in `services/fleet-mcp-bridge.service.ts` — and every deny case has a test.

**`add_comment` (#799)** is how a remote builder reflects progress onto the ticket instead of
leaving it in output nobody sees until the session ends. It is pinned twice over:

- **to the assignment's ISSUE.** The id comes from the DB per request, not from the token — an
  omitted `issueId` is filled in, a different one is refused with a pointer at `create_issue`.
- **to two KINDS**, `note` and `agent-question` (`REMOTE_COMMENT_KINDS`). The board's own route
  already refuses `preflight-verdict` and `gate-decision` because they are records of a MACHINE
  decision that a caller posting one would be forging; this narrows further, dropping
  `merge-attempt` and `preflight-clarification` as the board's own workflow bookkeeping.

The tool posts through `POST /api/issues/:id/comments` rather than inserting, because
`issue_comments` has exactly one write path (`insertIssueComment`) and that is where the #738
identical-repeat collapse lives — the rule that keeps a chatty writer from growing the table.

**The assignment is re-derived from the DB on every request (#799).** The git transport has done
this since #753; the MCP path used to rely on the token being dropped at `finishSession` /
`revokeWorker` plus a 24h TTL, so a board that crashed mid-session left a token valid for up to a
day with no assignment behind it. That was tolerable while the surface was read-only and stopped
being tolerable the moment a write joined it. Same predicate as the git side
(`isWorkerAssignmentCurrent`): running, or ended recently enough that the result is still
expected. Fails CLOSED — a lookup that throws is a 503, not a pass — and a token found to stand
for nothing is dropped so the next call is a plain 401.

**When the bridge is NOT offered** the brief keeps saying "no board tools", which stays true:

- no fleet listener in this board process (`KANBAN_FLEET_PORT` unset) — there is nowhere to serve it;
- the worker never opened a websocket to this process, so the board does not know the authority it
  dialed (the bridge URL is derived from that request's `Host` header, precisely so the board
  never has to know its own external hostname — the same reasoning that has the WORKER compose the
  git URL);
- the provider is **pi**. Not a plumbing gap: pi 0.73.1 has no MCP client at all (decision 007),
  so there is no configuration that would help, and a flag pi ignores would be worse than the
  honest brief. Closing it needs a pi EXTENSION that speaks MCP — upstream work, not board work.

**Three channels, one per provider family, and the difference is about where the TOKEN ends up:**

| Provider | How it is pointed at the bridge | Where the token rides |
|---|---|---|
| claude | `--mcp-config .mcp-kanban.json` | the config file in the checkout |
| copilot | `--additional-mcp-config @.mcp-kanban.json` | the config file in the checkout |
| codex (#799) | `-c mcp_servers.agentic-kanban.url=…` + `-c mcp_servers.agentic-kanban.bearer_token_env_var=AGENTIC_KANBAN_MCP_TOKEN` | `WorkerRepoTransport.boardMcpToken`, exported by the WORKER into the agent's env |
| pi | nothing — no MCP client | — |

Codex has no config-file flag, but it does take dotted `-c` overrides, and an HTTP MCP entry can
name an **env var** to read its bearer token from rather than carrying the token. So the argv
carries the URL and a variable NAME, never the secret — the same rule that took the git token out
of the clone URL. The token itself travels in its own field on the assignment (like `gitToken`)
and **not** in `spec.env`, which is projected through an allowlist that deliberately drops
anything token-shaped (`lib/remote-spec-env.ts`); widening that would weaken the exact guard that
keeps board credentials off a worker. The worker merges it into the child's environment just
before spawn.

Pointing `CODEX_HOME` at the checkout was the obvious alternative and is wrong: that variable
also selects the auth directory, so it would take the worker's own codex login away — decision
012 in reverse.

### What credentials-never-cross makes genuinely impossible

Not a bug, not fixable by more plumbing — write it down so it is not re-opened as one:

- **Profile selection cannot be honoured remotely.** `--settings ~/.claude/settings_<profile>.json`
  is both a board-host path and a credential selector, and a true-remote spec drops it (#747). So
  the Strategy Bullseye's profile choice and the auth-rotation ring's quota-based rotation **do not
  reach a worker** — the worker authenticates with its own local login, whatever that is. This is
  the same boundary that already makes `resolveWorkerPlacement` refuse remote placement for an
  allowlist-restricted project (#651). **Worker-side ATTESTATION** — a worker declaring which
  profiles it can authenticate as, the way it already declares `--providers`/`--labels` — is the
  only thing that narrows it.
- **`ANTHROPIC_MODEL` / `ANTHROPIC_BASE_URL` from a board profile never cross**, by design
  (`lib/remote-spec-env.ts`). Model selection travels in argv; the endpoint is the worker's.
- **The bridge does not change either of those.** A capability token authorises board TOOL CALLS.
  It is not an agent credential and cannot stand in for one.

## 10. Reference

- Design record: [decisions/012-worker-fleet-compute-model.md](decisions/012-worker-fleet-compute-model.md)
- Environment variables: [env-vars.md](env-vars.md)
- Generated runbook: `agentic-kanban-worker instructions --board <fleet-url>` (add `--json`
  for the same steps machine-readable)
- Observability (#755, #774): `services/placement-explain.service.ts` (the §7 chain,
  `describeFleet`), `services/worker-events.service.ts` +
  `repositories/worker-events.repository.ts` (§7a), `cli/commands/worker-doctor.ts`,
  `mcp-server/src/tools/worker-fleet.ts`
- Board-side modules: `services/worker-{registry,connection,fleet}.service.ts`,
  `services/agent-{dispatch,remote}.service.ts`, `services/git-http.service.ts`,
  `services/fleet-listener.service.ts`, `services/fleet-mcp-bridge.service.ts`,
  `startup/worker-incoming-sweep.ts`
- Worker-side modules: `worker/worker-{cli,daemon,agent-runner,repo,command-resolver}.ts`
- Wire protocol (both sides): `packages/shared/src/lib/worker-protocol.ts`
