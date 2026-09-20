# Decision 018: Herdr Optional Agent Support

## Date: 2026-09-16

## Status

**Active, phase 1 of the #1129 epic** (config discovery only — #1144). Phases 2-4
(#1145-#1147) are separate tickets and unimplemented; this document also corrects
a premise in the epic's phase-2/3 framing (#1145/#1146) before they are picked up.

## Context

Ticket #1129 asks for "herdr support for agents (optional)", decomposed into five
subtasks (#1144-#1148) shaped after Decision 007's Pi rollout: config discovery,
a provider adapter (spawn/stream/exit), safety-hook delegation, roster/quota/
Bullseye integration, and docs. That shape assumes herdr is a fourth kind of
thing alongside Claude/Codex/Copilot/Pi — an LLM coding-agent CLI harness.

**It is not.** Per `~/.claude/notes-core/guides/herdr.md`, herdr
(`github.com/herdrdev/herdr`, or our fork `github.com/p-wegner/herdr`) is a
**terminal multiplexer**: a background server that hosts long-lived terminal
panes so an agent process running inside one survives the terminal window
closing. It has no model, no `--mode json` event stream of its own, and no
`tool_call`-style hook it can veto — the hook mechanism Pi's `.pi/plugin/
agentic-kanban-hooks.ts` adapts (Decision 007) does not exist on herdr's side,
because herdr never sees the agent's tool calls; it only sees a terminal's
bytes in and out.

## Decision

Herdr is **not** added to `PROVIDER_NAMES`
(`packages/server/src/services/agent-provider/types.ts`). It does not answer
"which model/CLI runs this session" — every existing provider does — so forcing
it into that union would make every exhaustive provider switch
(`provider-exit-behavior.ts`'s `EXIT_BEHAVIORS` record,
`provider-pair-parity.test.ts`'s capability table, the client's provider
`<optgroup>`s, the Strategy Bullseye's provider literal) answer for a concept it
has no opinion on.

Instead, herdr is modeled as an **optional launch placement**, the same shape
`agent-provider/container-wrap.ts` already established for devcontainer
placement: a pure transform sitting between a provider's `buildLaunchConfig()`
and the one `spawn()` call in `agent.service.ts`, so every existing provider
(claude/codex/copilot/pi) is herdr-hostable without knowing herdr exists.

### Phase 1 (this ticket, #1144) — config discovery only

- `packages/server/src/lib/herdr-exec.ts` — the exec adapter (mirrors
  `docker-exec.ts`/`devcontainer-exec.ts`): `herdrExec`, `herdrAvailable`,
  `probeHerdr`. Server-only (#590/#730 single-consumer ratchet) — herdr
  discovery has exactly one consuming package, so it lives beside its caller
  rather than in `packages/shared/src/lib/`.
- `packages/server/src/services/herdr-availability.service.ts` —
  `getHerdrAvailability()`, a short-TTL cached probe (`herdr --version`),
  reporting `{available, version, isFork}`.
- `GET /api/herdr/availability` (`routes/herdr.ts`) — surfaces the probe.
- `herdr_hosted_agents` setting (`settings-registry.ts`) — an opt-in flag
  recording operator INTENT, off by default. It does not yet change any launch
  behavior; it exists so Settings/UI has something to bind to ahead of phase 2.

### Phase 2 (#1145, not this ticket) — the launch wrap

A `herdr-wrap.ts` mirroring `container-wrap.ts`'s contract: given a finished
`AgentLaunchConfig` and a herdr pane (existing or newly split via `herdr pane
split --cwd <worktree> --env ...`), rewrite `command`/`args` into `herdr pane
run <id> "<command> <args...>"`. Open questions phase 2 must answer before
writing that code (learned from the herdr guide, not yet verified against a
live board launch):

- **Exit code propagation.** `herdr pane run` starts a command in an existing
  pane; how does the board learn the wrapped process's exit code, given the
  board's own `spawn()` would now be watching the `herdr` CLI invocation (which
  returns once the pane accepts the command, not once it finishes) rather than
  the agent? The Worker Fleet's placement model (`Placement = host | container
  | remote`, Decision 012) is the closer analogy than `container-wrap.ts` here,
  since a herdr pane's lifecycle is observed asynchronously (`herdr pane read`
  / `herdr agent list` state) rather than reported by a direct child-process
  `exit` event.
- **Pane provisioning.** Unlike a devcontainer (`devcontainer up`, one command,
  synchronous), a herdr pane is a stateful thing the OPERATOR'S session usually
  already owns (see the guide's "per-pane profiles" section) — the board would
  need to either split its own pane tree or attach to operator-provisioned
  ones, and the guide's own traps (`--current` needs `HERDR_PANE_ID`, a fresh
  script has none) apply squarely to a board-spawned process that is not
  itself running inside a pane.
- **Windows-only today** — the herdr guide and its bootstrap script are
  Windows-specific; `herdrAvailable()` degrades to `false` cleanly on any
  platform/machine without herdr installed, so phase 2's fallback-to-direct-
  spawn behavior (mirroring `devcontainer_strict`'s off-by-default fallback) is
  not a new decision, just an application of the existing one.

### Phase 3 (#1146, not this ticket) — safety hooks

**Corrected scope.** herdr has no `tool_call`-equivalent hook to delegate to,
so there is nothing to port in the shape of `.pi/plugin/agentic-kanban-hooks.ts`
or `.opencode/plugin/agentic-kanban-hooks.ts`. The agent running *inside* a
herdr pane is still Claude/Codex/Copilot/Pi, unmodified, so it still runs its
own existing hooks (`.claude/hooks/*.js` via `.claude/settings.json`, or the
Pi/Codex/OpenCode equivalents) exactly as it would outside a pane — herdr sits
below the agent process, not between it and its tool calls. #1146 should be
re-scoped to: verify (not build) that hook behavior is unaffected by running
inside a herdr pane, since herdr's pane is a transparent PTY layer rather than
a tool-call intermediary.

### Phase 4 (#1147, not this ticket) — roster/quota/Bullseye

Herdr is a placement concern, not a profile/model concern, so it does not need
a `herdr_profile` preference or a roster entry the way claude/codex/pi profiles
do (Decision 012's `Placement` enum is again the closer precedent than a
provider profile). What #1147 likely needs is a per-workspace/per-project
`herdr_hosted_agents` override consulted at the same point `containerProvision`
is resolved in `agent.service.ts`'s `launch()` — not a new roster axis.

## Rationale

1. **Match the abstraction to the concept.** `PROVIDER_NAMES` means "which LLM
   CLI harness" everywhere it is consulted; herdr answers a different question
   ("where does the harness's terminal live"), and conflating the two would
   corrupt every exhaustive switch keyed on it.
2. **Placement, not provider, has a working precedent already.** Devcontainer
   placement (`container-wrap.ts`) and Worker Fleet placement (Decision 012)
   are both "run the SAME provider somewhere else" concerns; herdr is a third
   member of that family, not a sibling of Claude/Codex/Copilot/Pi.
3. **Ship the true dependency-free slice first.** Discovery has no
   dependency on an actual running pane and is fully testable (fake exec
   result -> `{available, version}`); the wrap does, and guessing its shape
   without a live herdr pane to launch into repeats Decision 007's own
   lesson ("map & verify the CLI before any parser code").

## Consequences / risks

- Until phase 2 lands, `herdr_hosted_agents` is a settings flag with no launch
  effect — turning it on changes nothing observable. This is intentional (the
  same "declare absence, don't leave it silent" rule the provider-pair-parity
  guard applies to providers) but should not be read as the feature being
  broken; it is not yet built.
- `getHerdrAvailability()`'s cache means a herdr install/uninstall on a running
  board takes up to 30s to be reflected — acceptable for a Settings-panel
  health check, not for a hot launch-time decision (phase 2 should re-probe
  synchronously or use a shorter TTL if it turns out to matter).
- The whole feature is Windows-first per the current herdr guide; other
  platforms simply see `available: false` and behave exactly as before.

## References

- `~/.claude/notes-core/guides/herdr.md` — the adoption guide this decision
  draws its facts from (bootstrap, traps, the pane API, the fork).
- Decision 007 (Pi) — the template this epic was seeded from, and the
  precedent for what changes when a genuinely new LLM harness is added.
- Decision 012 (Worker Fleet) — the closer precedent for herdr's actual shape
  (a placement, not a provider).
- `packages/server/src/services/agent-provider/container-wrap.ts` — the
  pure-transform pattern phase 2's wrap should follow.
