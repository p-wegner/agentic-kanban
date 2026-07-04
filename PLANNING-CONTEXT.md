# Planning Context — #996: Log resolved provider/model on fork launch

## Goal
`[fork]` log lines in `packages/server/src/services/workflow-fork.service.ts` don't
say which agent harness (provider/profile/model) a child or join session launched
on. Per-node agent overrides (`getNodeAgentOverride`) mean different fork branches
or the join stage can run on different providers/models than the parent — add that
info to the existing log lines so it's visible in server logs. Log-only change, no
behavior change.

## Current state
- `resolveAgentConfig(node?)` (line ~100) is the single resolution path: overlays
  the node's `agent` config override onto global prefs, then calls
  `resolveAgentSettings` + `resolveEffectiveModel`. Returns `{ provider, profile,
  claudeProfile, agentCommand, agentArgs, permissionPromptTool, model }`.
- `launchChild` (line ~256): calls `resolveAgentConfig(entry)` → `cfg`, then
  `getSessionManager().startSession(...)`. No log line currently marks an
  individual child's launch — only the aggregate line in `spawnForkChildren`
  (line 421): `` `[fork] parent=${parent.id} spawned ${launchedNow}/${entries.length} children now (rest queued).` ``.
- `launchJoinAgent` (line ~572): calls `resolveAgentConfig(joinNode)` → `cfg`,
  then `startSession(...)`. Currently only logs on failure (`.catch` at line 607);
  no log line on the (successful) launch itself.

## Planned changes (both log-only, no new deps)
1. In `launchChild`, add a per-child `console.log` right before/after
   `startSession` fires, including `entry.name`, resolved `cfg.provider`, and
   `cfg.model` (only if set — ticket says "and model when set"). Follows the
   `[fork]` prefix style used elsewhere (e.g. `` `[fork] child launch failed (...)` ``).
   Ticket explicitly prefers this per-child line over (or in addition to)
   extending the per-parent summary line in `spawnForkChildren`.
2. In `launchJoinAgent`, add a `console.log` when the join session launches,
   including `joinNode.name`, `cfg.provider`, and `cfg.model` (if set).

## Constraints
- Scope: `workflow-fork.service.ts` only (test file optionally, if a console-spy
  assertion is cheap).
- No new dependencies, no behavior changes — purely additive log lines.
- Keep the existing `[fork]` prefix convention and existing log lines intact
  (don't remove/rework the aggregate spawn summary or the failure/error logs).

## Open questions
- Whether to still touch the aggregate line in `spawnForkChildren` in addition to
  the per-child line — ticket says "or better a per-child line", implying the
  per-child line alone satisfies the requirement; leaning toward per-child only
  to keep the diff minimal, unless split-planning decides otherwise.
- Whether a unit test is worth adding: no existing console spies in
  `workflow-fork.test.ts`; a `vi.spyOn(console, "log")` assertion around one of
  the existing `startSession`-asserting tests would be cheap to bolt on, but per
  the ticket this is optional.
