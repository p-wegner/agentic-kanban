# Final Plan — #996: Log resolved provider/model on fork launch

## Consolidation of parallel plans

Two planner branches ran (`fork-claude-plan`, `fork-codex-plan`); both produced
only a plan document, no implementation. They agreed on the core approach:

- Add a per-child `console.log` in `launchChild`, right after
  `resolveAgentConfig(entry)` resolves `cfg`, before `startSession(...)` fires.
- Add a per-join `console.log` in `launchJoinAgent`, right after
  `resolveAgentConfig(joinNode)` resolves `cfg`, before `startSession(...)` fires.
- Leave the existing aggregate `[fork] parent=... spawned N/M children` line and
  all `console.warn`/`console.error` lines untouched.
- Log `cfg.model` only when set.

Where they differed: the codex plan proposed a small `formatResolvedAgentLog`
helper; the claude plan inlined the ternary directly. Adopted: **inline**,
matching this file's existing style (no local formatter helpers elsewhere in
the file) and keeping the diff smaller.

One correctness point neither plan resolved concretely: `cfg.provider` (e.g.
`"claude"`) is the value stored on the workspace row, but `toExecutorProvider(cfg.provider)`
(e.g. `"claude-code"`) is what's actually passed to `startSession(...)` as the
executor provider id. The codex plan flagged this ambiguity explicitly. Adopted:
**log `toExecutorProvider(cfg.provider)`**, because that's the value that
determines which harness actually launches, and because the existing
`workflow-fork.test.ts` `multi-harness-review` test (already on this branch,
predating this consolidation) asserts the log line contains `"claude-code"` /
`"codex"` — the executor-id form, not the raw stored provider name.

## Implementation status

This branch's prior commit (aa0fbe96) had already implemented both log lines
using the raw `cfg.provider`. This consolidation pass corrected both to use
`toExecutorProvider(cfg.provider)` so the log matches the test expectations and
the actual launched harness.

## Files changed

- `packages/server/src/services/workflow-fork.service.ts` — the two log lines.
- `packages/server/src/__tests__/workflow-fork.test.ts` — already covers this
  (added in a prior commit on this branch); no further test changes needed.
