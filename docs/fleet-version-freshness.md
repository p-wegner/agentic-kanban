# Fleet version freshness (#860)

Two separate freshness problems: does a remote agent build against current CODE, and how
does the standing worker RUNNER itself get updated. Findings below are evidence-based —
each claim names the file/line that establishes it. Section 3 states what could not be
verified from this machine.

## How this was investigated

This document was written from inside a **remote fleet worker checkout** (per
`CLAUDE.local.md`: no board MCP tools, no board HTTP API reachable, work travels only as
commits). All findings are from reading the board's own source in this checkout — nothing
here is a live cross-machine observation. Where that matters, it's called out.

---

## 1. Does a remote agent always work against up-to-date code?

### 1.1 Code freshness at dispatch — TRUE: always current at that moment

`provisionWorkerCheckout` (`packages/server/src/worker/worker-repo.ts:74-149`) runs on
**every** assignment, not just the first:

- No cached clone yet → `git clone`.
- Cached clone exists → `git fetch … +refs/heads/*:refs/remotes/origin/* --prune` with a
  **fresh per-assignment token** (worker-repo.ts:90-95, comment: "A token is per-assignment
  — always fetch with the CURRENT credential").
- The branch start point is resolved AFTER that fetch: `origin/<branch>` if the board
  already has it (resume), else `origin/<baseBranch>` (worker-repo.ts:109-113).

So a second/third/tenth dispatch to the same worker always re-fetches before building the
session's worktree — there is no "pinned at first clone" staleness. The per-session
worktree itself (`checkouts/<sessionId>`) is created fresh every time (stale one from a
crashed session is force-removed first, worker-repo.ts:98-101).

### 1.2 What the branch is based on — TRUE: board's `origin/<baseBranch>` at fetch time

Confirmed by the code path above: the start point is always resolved against the
just-fetched `origin/*` refs, i.e. the board's real branch/baseBranch as of THIS dispatch —
never something older that predates the fetch.

**Mid-session staleness is a separate, already-handled case.** A long-running session's
worker checkout does NOT auto-refresh on its own — but `gateRemoteTurn`
(`packages/server/src/services/worker-remote-sync.service.ts:305-361`) runs before every
follow-up turn to a remote session and:
1. asks the worker to fast-forward its checkout to the board's current branch tip
   (`sync_repo` / `syncWorkerCheckout`, worker-repo.ts:214-268 — fast-forward only, never
   `reset --hard`, never `--force`);
2. **refuses the turn** (409 CONFLICT or 422 UNPROCESSABLE) rather than delivering it into a
   checkout that turned out to be `diverged` or `dirty-held`, or whose worker's liveness is
   not provably `alive`.

So the "~20 commits behind → declines to auto-merge" failure mode the ticket names is not
worker-specific — it is the board's general stale-base guard
(`startup/done-unmerged-invariant-sweep.ts:251-261`, `maxCommitsBehindBase`), and it applies
identically to worker and host sessions because both land through the same branch/merge
machinery. What IS worker-specific and already built is the turn-time refusal above, which
exists specifically to stop a worker session from silently building on a base the board has
since moved past.

**Not fully verified**: I could not exercise a real multi-worker, multi-turn session from
this environment (no board API reachable) to watch `gateRemoteTurn` fire live. The claim
above is a straight reading of the code and its own test file
(`packages/server/src/__tests__/remote-turn-checkout-sync.test.ts`), not an observed run.

### 1.3 `packages/shared/dist` — TRUE, the trap is closed by the same mechanism as everywhere else

`provisionWorkerCheckout` runs the project's persisted `setup_script` in the fresh worktree
AFTER cloning/fetching and BEFORE the agent launches (worker-repo.ts:141-146), exactly like
a board worktree. For this repo, the default derived `setup_script` is `pnpm install -r`
(per root CLAUDE.md, #810), and `packages/shared/package.json` declares
`"prepare": "pnpm build"` (verified by reading the file directly — line 41-42), which pnpm
runs on every `pnpm install -r`. So a worker's fresh worktree gets `shared/dist` rebuilt the
same way a fresh board worktree does; the setup script IS what closes #846's trap, not
something bespoke to hosts.

**Residual risk, not closed**: this only holds if the project's `setup_script` is actually
populated. CLAUDE.md's own history (issue #37: "CLI 'register' skips setup_script +
verify_script population — duplicate registration path") shows this has been silently empty
before for a real project. `provisionWorkerCheckout` treats an empty/whitespace
`setupScript` as "skip" (worker-repo.ts:141: `if (repo.setupScript?.trim())`) — a worker
dispatched to a project with an empty setup script gets **no install and no build at all**,
which is a worse failure than a stale dist (nothing runs, not even `node_modules`). This is
silent: there is no worker-side check that a repo needing an install actually got one.

Second-dispatch behavior for `node_modules`: each session gets a brand-new `git worktree
add` (worker-repo.ts:113), which does NOT share `node_modules` with the cache clone or a
prior session's worktree (worktrees never do, absent a symlink). So `node_modules` is a
**genuinely fresh install every single dispatch**, landing on a warm pnpm store if one
exists on that worker machine. This matches the board's own "install-per-worktree" model
(root CLAUDE.md) rather than being a worker-specific behavior — consistent, not a special
case, but also not free: a worker doing many dispatches pays a full `pnpm install -r` every
time with no reuse across sessions (only the pnpm store caches).

### 1.4 Toolchain skew (Node/pnpm) — TRUE gap, and MEASURED on this machine

There is **no version check anywhere** for Node or pnpm on the worker side. Evidence:
- `worker-doctor.ts` (`packages/server/src/cli/commands/worker-doctor.ts`) runs 7+ checks
  (fleet reachability, heartbeat auth, WebSocket upgrade, git transport, git-on-PATH,
  checkout trust, provider CLI presence+login) — none of them check `node --version` or
  `pnpm --version` against the repo's declared floor.
- `agent-cli-version.service.ts` has a whole min/max-known version-range guard **for the
  agent CLIs** (claude/codex/copilot/pi — `CLI_VERSION_CONFIG`,
  `agent-cli-version.service.ts:58-60`), with an explicit maintenance note to re-verify on
  every provider CLI bump. There is no equivalent for the Node runtime the worker daemon
  itself runs under, despite the repo declaring a hard floor: `package.json`
  `"engines": { "node": ">=22" }` (root CLAUDE.md also states "Node LTS 22 floor (#731)").

**Measured on the machine this session is running on** (this checkout, presented as a
"remote fleet worker" per `CLAUDE.local.md`):
```
node --version   → v26.1.0
pnpm --version   → 10.12.1
git --version    → 2.39.1.windows.1
```
`v26.1.0` satisfies `>=22`, so this is not itself a violation — but it is real, unmanaged
skew from the LTS 22 baseline the rest of the docs assume, on a machine nothing checked.
There is no mechanism that would catch a worker running Node 18 (below the floor) or a
worker whose pnpm major version diverges enough to change lockfile/resolution behavior — it
would simply fail wherever the version-sensitive behavior first bites, with a generic error
that this fleet has no version-aware diagnostic for.

---

## 2. How does the RUNNER (worker daemon) get updated?

### 2.1 Compatibility contract — TRUE, and it's the one part of this ticket already well-built

There IS a version handshake, built deliberately for exactly the failure this ticket
describes (see `packages/shared/src/lib/worker-protocol.ts:200-239`, header comment on
`WORKER_PROTOCOL_VERSION`):

- **`protocolVersion`** (currently `1`) is a WIRE-format version, carried on `register`, on
  every `heartbeat`, and on every `hello` (`worker-daemon.ts:193,410-418,552`). A board
  refuses an incompatible worker with **409**, both at registration
  (`workers.ts:290-299`) and on every heartbeat (`workers.ts:337-360`) — and a currently
  connected worker that becomes incompatible (a board upgrade mid-connection) is marked
  `offline` immediately rather than waiting for the 90s heartbeat-staleness window
  (`worker-registry.service.ts:236-246`, comment: "must stop being a placement candidate
  now, not in 90s").
- **The daemon treats 409 as FATAL, not retryable** (`worker-daemon.ts:520-526,563-569`):
  it stops reconnecting and tells the operator to rebuild the tarball
  (`node scripts/pack-worker.mjs`) — this is precisely "refuse new work" rather than "run
  new work with old code," which is what the ticket asks for.
- **A pre-handshake (very old, pre-#754) worker is NOT silently refused** — it's assumed to
  speak protocol 1 (`PRE_HANDSHAKE_ASSUMED_PROTOCOL_VERSION`, worker-protocol.ts:219-239),
  explicitly reasoned as "protocol 1 IS the wire format as it stood when the handshake was
  added," so an old-but-working worker on someone else's machine isn't broken by adding the
  handshake itself.
- **`workerVersion`** (the package build string, from `package.json`'s own `version` field,
  resolved by walking up from the daemon's own file — `worker-daemon.ts:141-163`) rides
  alongside `protocolVersion` on the same three messages, purely informational: it's shown
  in `worker list` / the fleet panel and is what a version-aware human decision (not an
  automatic one) is made from. It is explicitly NOT trusted as ground truth when absent
  (`WorkerView` comment, `worker-registry.service.ts:71-79`: "we assumed 1" and "it said 1"
  are different facts, so the UI shows `?` rather than pretending).

**Silent misbehavior across version skew — the outcome the ticket names as the one to
design against — is therefore NOT the current failure mode for the WIRE PROTOCOL.** An
old/incompatible worker gets a legible refusal at both registration and heartbeat time. What
IS still silent: a message-SHAPE change that stays within the same `protocolVersion`
(described as fine by the header comment: "Adding an OPTIONAL field is not such a change")
relies on every parser degrading gracefully, which the shape-checking parsers in
`worker-protocol.ts` do (`parseBoardToWorkerMessage`/`parseWorkerToBoardMessage` drop
unknown fields, never throw on an unrecognized message type) — this is sound but untested
against a REAL cross-build pairing since I cannot run two different worker builds against
each other from this environment.

### 2.2 Update mechanism — BROKEN/ABSENT: this is the real gap

There is no update mechanism at all, self-update or otherwise. Evidence, read end to end:

- `ak-worker-service.ps1 -Install` resolves the worker binary ONCE at install time
  (`Get-Command agentic-kanban-worker`) and writes its **absolute path** into
  `config.json`'s `workerCmd` (`ak-worker-service.ps1:109-133`).
- `ak-worker-run.ps1`, the Scheduled-Task supervisor, reads that same `workerCmd` from
  config on every restart and always re-execs the SAME resolved binary
  (`ak-worker-run.ps1:63-82,96-111`) — there is no step anywhere in this loop that checks
  for a newer tarball, downloads one, or re-resolves the binary path.
- `scripts/pack-worker.mjs` produces an installable tarball but is a **manual, operator-run
  build step** — nothing calls it automatically, and nothing on the worker machine polls for
  a new one. The daemon's only reaction to "the board has moved on" is the 409 refusal
  above, which tells a human what to do; it does not do it.
- So the actual update mechanism today is 100% manual: an operator runs
  `node scripts/pack-worker.mjs`, copies the tarball to the worker machine (by hand, or via
  the `--blob`/ACP relay path), runs `npm i -g <tarball>` there, and restarts the Scheduled
  Task (`ak-worker-service.ps1 -Restart`) — nothing in the daemon or the task prompts for or
  performs any of these steps.

**This is exactly the risk the ticket's premise describes.** The whole point of the
Scheduled-Task supervisor (#surviving reboot/logoff) was uptime; nothing was built on the
freshness side to match it, so a worker that used to die naturally at session-end (forcing a
fresh install next time) now runs the SAME BUILD indefinitely unless a human separately
remembers to update it. The 409 handshake means it fails LOUD when the board finally makes a
breaking wire change — but for the (more common) case of "just some bug fixes since," a
worker can sit stale for weeks with nothing flagging it, connected and accepting work the
whole time, since `protocolVersion` deliberately does NOT bump for compatible changes.

**Update must never interrupt an in-flight assignment** — no design proposed here, see §4
below; this section only establishes that no mechanism exists yet, safe or otherwise.

### 2.3 Crash-loop visibility — PARTIAL: logged locally, invisible to the board

`ak-worker-run.ps1`'s backoff (`$delay = 2` doubling to a `300`s cap, lines 95-111) logs
every restart with how long the daemon ran (`ranFor`) to the LOCAL log file
(`%LOCALAPPDATA%\agentic-kanban-worker\worker.log`). It resets the backoff to 2s only after
a run of ≥60s, so a genuine crash-loop (each run <60s) climbs to and stays at a 5-minute
retry cadence — reasonable throttling, but:

- **Nothing pushes this to the board.** The worker only reaches the board once the daemon
  is actually up and reconnected; a crash-looping daemon spends most of its time NOT
  connected, so from the board's side this worker just looks intermittently `offline` (via
  the 90s heartbeat-staleness downgrade, `worker-registry.service.ts:93-101`) — indistinguishable
  from a flaky network or a machine that's asleep. `worker doctor` / `worker doctor-board`
  (`worker-doctor.ts`) are pull-based diagnostics an operator has to think to run; there is
  no push alert.
- `WorkerFleetPanel.tsx` and the fleet listing show `effectiveStatus` (online/draining/offline)
  and `connected`, which is exactly this ambiguous signal — no distinct "crash-looping"
  state exists in the wire protocol or the DB.

**Could not verify from this environment**: whether an operator watching the dashboard
(`ak-worker-dashboard.mjs`, mentioned in the ticket's context primer) would notice a
crash-loop faster than the board side would, since that dashboard runs on the WORKER machine
reading the same local log — plausible that it would surface `ranFor` timings directly, but
I have not run it.

---

## 3. What could not be verified from here

- No live board to register against, dispatch to, or watch a real multi-turn remote session
  against (`gateRemoteTurn` in practice, not just in its own test file).
- No second machine to actually build an OLD worker tarball and pair it against a NEWER
  board (or vice versa) to watch the 409 refusal fire end-to-end rather than by reading the
  code that implements it.
- Whether `ak-worker-dashboard.mjs` (the worker-side dashboard mentioned in the ticket's
  context primer) exposes crash-loop/version state better than the log file does — not run.
- Whether a real `setup_script`-less project (the #37 failure mode) is still reachable
  today via any registration path, given #810 changed the default derivation — not
  reproduced, only reasoned about from the code.

---

## 4. Prioritized proposals

Each is sized to be filed as its own ticket from this document.

### P1 — Worker-side toolchain version check in `worker doctor` (small, low risk)

**Why it matters**: §1.4 — no check anywhere on the worker catches a Node/pnpm version that
diverges from what the repo declares, and this is the class of failure that looks exactly
like "something unrelated is broken" (the same shape the ticket calls out for
`shared/dist`). Cheap to add given `worker-doctor.ts` already has the exact shape for this
(`checkGit`, `checkProvider`) and reads `package.json` `engines.node` is a one-line lookup
relative to the daemon's own resolved path (same trick `resolveWorkerVersion()` already
uses).

**Done looks like**: a new `DoctorCheck` in `runWorkerDoctor` that runs `node --version`
and `pnpm --version`, compares against `engines.node` and (if a pinned `packageManager`
field exists) the declared pnpm version, and reports `fail` only when Node is below the
floor (mirroring the `fail`-means-actionable discipline the rest of that file already
follows — see its own header comment about `unknown` vs `fail`). Test: extend
`worker-doctor.test.ts` (or its sibling) with a case for a too-old Node string.

**Risk**: low. Read-only, additive check; cannot break an existing passing doctor run.

### P2 — Worker binary staleness surfaced on the board (`worker list` / fleet panel), not just refused at the wire level (medium, low-medium risk)

**Why it matters**: §2.1/§2.2 — the 409 handshake only fires on an incompatible WIRE
change, which the codebase deliberately keeps rare (optional-field additions don't bump it).
A worker can be weeks of bug fixes behind and look perfectly healthy on the fleet panel
forever, because `workerVersion` is currently display-only (`WorkerView`, worker-registry.service.ts:71-79)
and nothing compares it to "the version the board itself was built from."

**Done looks like**: the board compares each worker's reported `workerVersion` against its
OWN `package.json` version (available in-process already — same lookup
`resolveWorkerVersion()` does, just server-side) and surfaces a non-blocking "N versions
behind" badge in `WorkerFleetPanel.tsx` / `worker list` output, sourced from the SAME
`reportedVersions` map `worker-registry.service.ts` already maintains — no new persistence,
no new wire message. Explicitly NOT a refusal (that's what `protocolVersion` is for) — just
visibility, so an operator doesn't need to remember to check.

**Risk**: low-medium. Touches display code and a version-compare helper; must not confuse
a worker-ahead-of-board case (dev machine testing a newer worker build) with staleness —
name both directions distinctly rather than a bare "outdated" label.

### P3 — A `worker update-check` command that reports (not performs) an available tarball (medium, low risk if scoped to read-only)

**Why it matters**: §2.2 is the core finding — there is no update mechanism, self-update or
otherwise, and the ticket explicitly says NOT to build a live self-update (correctly — this
session may be running on the very worker in question). A safe, useful middle step: a
command an operator (or a scheduled task) can run that answers "is a newer tarball
available" without applying anything, closing the gap between "silent staleness forever" and
"risky auto-update."

**Done looks like**: `agentic-kanban-worker update-check --board <url>` (or a `worker
doctor` addition) that calls a new lightweight board endpoint (or reads a version stamped
into an existing response) reporting the board's current `workerVersion`/build, and prints
a diff against its own `resolveWorkerVersion()` plus the exact manual remediation steps
(`node scripts/pack-worker.mjs`, copy, `npm i -g`, `ak-worker-service.ps1 -Restart`) already
documented in the 409-refusal message. No download, no install, no restart — reporting only.

**Risk**: low if scoped exactly as above (read-only check). The risk rises sharply the
moment this is extended to actually fetch/install/restart — that step needs its own ticket,
its own design for "never interrupt an in-flight assignment" (drain first, the way `stop()`
already does in `worker-daemon.ts:601-646`), and should NOT be attempted by an agent that
might be running on the worker being updated (this ticket's own instruction, correctly).

### P4 — Push crash-loop state to the board, not just the local log (medium, low risk)

**Why it matters**: §2.3 — a crash-looping worker is invisible to the board beyond looking
intermittently offline, which an operator has no reason to distinguish from a flaky network
without already suspecting a crash-loop and going to run `worker doctor` by hand.

**Done looks like**: `ak-worker-run.ps1` already computes `$ranFor` per restart; the
simplest version of this is having the DAEMON itself (not the PowerShell wrapper, which has
no board connection) track "this process's own uptime" and include a `restartsInLastHour`-
style counter in its heartbeat payload once it reconnects after a short-lived prior run —
detectable process-side via a marker file or the daemon's own start-of-run timestamp
compared against a previous one it wrote to the state file. Surfaced the same way P2's badge
is, on the fleet panel.

**Risk**: low-medium. The tricky part is correctly distinguishing "this is a fresh install's
first run" from "this is restart #40 of a crash loop" without over-engineering a new
persistence layer — likely reuses `worker-state.json`, which already exists and is already
read/written by the daemon (`worker-daemon.ts:114-130`).

### P5 (backlog note, not sized as a ticket) — a real self-update mechanism, once P3 exists

Explicitly deferred, per this ticket's own instruction. Once P3 gives operators (and any
future automated supervisor) a safe way to KNOW a worker is stale, the actual update
mechanism — drain, replace binary, restart — is a separate, higher-risk design that should
be scoped and reviewed on its own, likely building on `worker-daemon.ts`'s existing
`drain()`/`stop()` machinery (already correctly bounded and non-destructive to in-flight
work) rather than inventing new shutdown semantics.
