/**
 * Neutralise the AMBIENT quota read for unit tests.
 *
 * `loadProjectRuntimeConfig` asks for live 5-hour readings on every launch resolution
 * (#1026), and since #1023 the default source is the OAuth usage endpoint read with each
 * local Claude profile's own token. In a unit test that means a real network request from
 * the developer's machine, and — worse — it lets the operator's own account usage decide
 * what the code under test resolves: a profile at or above the pool-exhausted threshold is
 * skipped BEFORE the start, so the Strategy Bullseye's chosen provider silently becomes a
 * fallback to whatever the workspace row had baked in.
 *
 * Measured on master (2026-09-20): `resolver-provider-relaunch` and `review-concurrent` both
 * asserted the Bullseye default `codex:default` and both received `claude`, green in
 * isolation and red in the sweep, with no commit between the two runs — the only thing that
 * had changed was the live reading. The board's own `default` Claude login supplied the
 * number, through the bare-name key the quota source publishes (that cross-provider read is
 * a separate defect, fixed in `headroomRecordFor`).
 *
 * Same move as `temp-health-neutral.ts` for `%TEMP%`, and it weakens nothing: the selection
 * logic is covered directly against headroom maps the tests construct themselves
 * (`profile-roster-selection`, `strategy-provider-selection`, `provider-quota-gating`), and
 * the OAuth provider has its own suite. What is switched off is only the ambient read.
 *
 * Not forced: an explicit `KANBAN_QUOTA_SOURCE` from the environment wins, and any test may
 * still install its own provider with `setQuotaUsageProvider()`.
 */
if (process.env.KANBAN_QUOTA_SOURCE === undefined) {
  process.env.KANBAN_QUOTA_SOURCE = "none";
}
