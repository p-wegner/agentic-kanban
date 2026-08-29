/**
 * Session-exit stats builders — the persisted `sessions.stats` payloads for each terminal
 * exit route (launch-failure, usage-limit, indeterminate). Extracted from session-lifecycle.ts
 * so BOTH the live exit path and the external/reattach exit path share one definition (and so
 * session-lifecycle.ts stays under the god-module line ceiling). Pure: no DB, no I/O.
 */
import { ZERO_OUTPUT_LAUNCH_FAILURE_WINDOW_MS } from "./session-exit-state-machine.js";

export function buildZeroOutputLaunchFailureStats(executor: string, durationMs: number, exitCode: number | null, stderrText?: string) {
  // Surface the provider's captured stderr (#779). A detached claude.exe that dies on launch
  // writes its reason to stderr, not stdout; including it here turns an opaque "zero output"
  // crash into a diagnosable failure (e.g. a mid-rebase worktree, bad cwd, auth error).
  const stderrSnippet = stderrText?.trim()
    ? `\nProvider stderr:\n${stderrText.trim().length > 500 ? stderrText.trim().slice(0, 500) + "…" : stderrText.trim()}`
    : "";
  const reason =
    `Agent launch failed: provider process exited within ${Math.round(ZERO_OUTPUT_LAUNCH_FAILURE_WINDOW_MS / 1000)}s ` +
    "without assistant output, tool activity, or usage stats." +
    stderrSnippet;
  return {
    durationMs,
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    numTurns: 0,
    model: executor,
    success: false,
    launchFailure: true,
    failureReason: reason,
    providerExitCode: exitCode,
    agentSummary: reason,
  };
}

/**
 * Build launch failure stats when the agent produced an error message but is still a failed
 * launch (e.g. model/auth error).
 *
 * The duration is REPORTED rather than asserted (#934): this route is no longer reached only
 * inside the 10s window — a non-zero exit whose only output was a failed terminal result is a
 * launch failure at any duration — so the old "exited within 10s" wording would have been a
 * false statement on exactly the failures that motivated widening it.
 */
export function buildModelErrorLaunchFailureStats(executor: string, durationMs: number, exitCode: number | null, errorText: string) {
  const truncated = errorText.length > 500 ? errorText.slice(0, 500) + "…" : errorText;
  const reason =
    `Agent launch failed: provider process exited after ${Math.round(durationMs / 1000)}s ` +
    `with non-zero exit code ${exitCode ?? "unknown"} and error output:\n${truncated}`;
  return {
    durationMs,
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    numTurns: 0,
    model: executor,
    success: false,
    launchFailure: true,
    failureReason: reason,
    providerExitCode: exitCode,
    agentSummary: truncated,
  };
}

/**
 * Stats for a launch that failed because the provider could not find the resumed
 * conversation's transcript (missing-transcript fallback). Distinct from a plain
 * model/auth launch failure so the recovery is visible in session history — the
 * caller still relaunches fresh right after persisting this.
 */
export function buildStaleResumeLaunchFailureStats(executor: string, durationMs: number, exitCode: number | null, errorText: string) {
  const truncated = errorText.length > 500 ? errorText.slice(0, 500) + "…" : errorText;
  const reason =
    "Agent resume failed: the provider could not find the previous conversation's transcript " +
    "(likely lost/pruned state). Clearing the stale resume id and relaunching fresh." +
    (truncated ? `\n${truncated}` : "");
  return {
    durationMs,
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    numTurns: 0,
    model: executor,
    success: false,
    launchFailure: true,
    staleResumeRecovered: true,
    failureReason: reason,
    providerExitCode: exitCode,
    agentSummary: reason,
  };
}

// The two per-provider usage-limit builders lived here and were identical but for the
// `rateLimitKind` literal; they are one `buildUsageLimitStats(kind, …)` in shared now (#542),
// which `exit-finalize.ts` calls directly with the kind it has already discriminated on.

/**
 * Stats for an INDETERMINATE exit — the real exit code was never observed (external/reattach PID
 * poll after a server restart). `success: false` + `indeterminateExit: true` + `providerExitCode:
 * null` mark it as neither a verified success nor a definite failure, so downstream never treats
 * a post-restart crash/quota-exhaustion as a clean completion (review §3.2).
 */
export function buildIndeterminateExitStats(executor: string, durationMs: number, hadSubstantiveOutput: boolean, stderrText: string) {
  const stderrSnippet = stderrText?.trim()
    ? `\nProvider stderr:\n${stderrText.trim().length > 500 ? stderrText.trim().slice(0, 500) + "…" : stderrText.trim()}`
    : "";
  const reason =
    "Agent exit state indeterminate: the reattached provider process ended after a server " +
    "restart, so its real exit code could not be observed. Recorded as an indeterminate terminal " +
    "state (neither a verified success nor a definite failure)." +
    stderrSnippet;
  return {
    durationMs,
    model: executor,
    success: false,
    indeterminateExit: true,
    hadSubstantiveOutput,
    failureReason: reason,
    providerExitCode: null,
    agentSummary: reason,
  };
}

/**
 * The operator-facing sentence for a launch failure, in the butler feed.
 *
 * Three genuinely different failures share this route and each needs its own wording: a stale
 * `--resume` (recovering itself), a non-zero exit (which carries the provider's own error text),
 * and a zero-output crash (where the only fact available is that nothing came back at all).
 */
export function launchFailureButlerText(input: {
  workspaceId: string;
  isStaleResume: boolean;
  isNonZeroExit: boolean;
  effectiveExitCode: number | null;
  durationMs: number;
  errorText?: string | null;
}): string {
  const seconds = Math.round(input.durationMs / 1000);
  if (input.isStaleResume) {
    return `Agent resume failed for workspace ${input.workspaceId}: the previous conversation transcript was missing. `
      + "Clearing the stale resume id and relaunching fresh.";
  }
  if (input.isNonZeroExit) {
    return `Agent launch failed for workspace ${input.workspaceId}: exited with code ${input.effectiveExitCode} in ${seconds}s`
      + `${input.errorText ? ` — ${input.errorText.slice(0, 200)}` : ""}.`;
  }
  return `Agent launch failed for workspace ${input.workspaceId}: zero output within ${seconds}s.`;
}
