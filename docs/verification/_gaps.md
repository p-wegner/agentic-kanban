# Coverage gaps — all capabilities

Every behaviour that is not `covered`, grouped by capability. `partial` = touched/some-dimensions; `uncovered` = no asserting test. Lead with the five-way taxonomy counts.

**Totals:** 271 covered · 3 partial · 0 uncovered · 0 undocumented-implemented · 0 documented-missing.

## monitor-orchestration (15/18 covered)

- **[partial]** `monitor-orchestration.guard.re-entrancy-and-maintenance` _(missing: state-transition)_ — No test asserts the re-entrancy guard (a mid-cycle trigger runs exactly one more pass, never two concurrent cycles) nor the maintenance-window suppression. startup-timers-hmr covers timer-handle recreation only, not the in-cycle guard. This

## agent-providers (14/16 covered)

- **[partial]** `agent-providers.login.oauthBootstrap` _(missing: error-handling)_ — No test exercises claude-login.service.ts / codex-login.service.ts. The load-bearing invariant (windowsHide:false so the OAuth callback survives) and the non-fatal-failure / returned-manual-command contract are entirely unverified. Hard to 

## agent-sessions (17/20 covered)

- **[partial]** `agent-sessions.persist.split-batch` _(missing: concurrency)_ — stdoutâ†’file split and the 50-row batch flush are asserted; the 250ms time-based flush, the flush-on-exit guarantee, and the swallowed FK-constraint insert race (broadcast.ts:92) are not asserted

