# Verification priorities — ROI-ranked backlog (all capabilities)

Aggregated from each capability's `top_gaps` (see per-capability files in `capabilities/` for full behaviour context). Ranked P-band then ROI. ROI = (business_impact × regression_value) / (exec_cost + maint_cost).

> The detailed, self-contained gap specs for the `workspaces` capability (the first authored slice) and the post-merge cascade follow-up live in git history of this file; one of them (`workspaces.cascade.post-merge-followups`) is already CLOSED — see `_authored.json`.

| Rank | P | ROI | Capability | Behaviour | Dimensions to add | Why |
|--:|---|--:|---|---|---|---|
| 1 | P2 | 3.00 | agent-sessions | `agent-sessions.persist.split-batch` | error-handling, concurrency | Flush-on-exit (no lost tail message) and the swallowed FK-insert race are unasserted; both are data-integrity guarantees of the transcript of record. |
| 2 | high | NaN | monitor-orchestration | `monitor-orchestration.guard.re-entrancy-and-maintenance` | state-transition, regression | The module's defining safety invariant â€” never double-drive a board (two concurrent cycles each POST a workspace for the same unblocked issue â†’ conflicting worktrees) â€” has zero coverage, and the maintenance-window suppression is also |
| 3 | medium | NaN | agent-providers | `agent-providers.login.oauthBootstrap` | workflow, error-handling, config | Zero coverage of the OAuth login bootstrap. The windowsHide:false invariant (callback server must run foreground) and the non-fatal-failure + returned-manual-command behavior are unverified. Unit-testable with a mocked spawn asserting the c |

_3 ranked gaps. Author top-down with the `e2e-test-author` skill; stop at the ROI bar you set._
