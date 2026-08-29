/**
 * Once-per-run logging for the pending-sibling scan (#939).
 *
 * `listPendingSiblingMerges` (workspace-internals.ts) runs for every merged workspace on
 * every merge/reconciler pass. A sibling repo whose directory has been deleted is a STEADY
 * STATE — it does not come back on its own — so an unconditional `console.warn` re-printed
 * the same line forever: grepping `[workspace-merge]` during live triage of a stuck merge
 * returned almost nothing else, and the gate/phase lines for the workspace actually under
 * investigation were pushed out of the log tail.
 *
 * The dedup is a LOGGING concern only. The scan's return value is unchanged — the row is
 * still reported `unverifiable`, still blocks the merge, and its reason still reaches
 * `checkPendingSiblingMergeGuards` and the workspace comment — so the condition stays
 * fully discoverable; it just stops being re-announced.
 */

/**
 * Warnings already emitted in THIS server run, keyed by `<workspaceId>::<repoPath>::<kind>`.
 *
 * Process-lifetime and never pruned: the key set is bounded by workspaces × sibling repos,
 * and a restart is exactly when an operator wants the current state re-stated.
 */
const loggedSiblingScanWarnings = new Set<string>();

/** Test seam: forget which sibling-scan warnings this run has already emitted. */
export function resetSiblingScanWarningLog(): void {
  loggedSiblingScanWarnings.clear();
}

/**
 * Warn about a sibling-scan problem at most once per (workspace, repo, kind) per run.
 *
 * `kind` is what decides "same condition or new information": a missing directory uses a
 * fixed kind (one line ever), while a git failure keys on the ERROR TEXT so a DIFFERENT
 * failure on the same repo still logs.
 */
export function warnSiblingScanOnce(workspaceId: string, repoPath: string, kind: string, reason: string): void {
  const key = `${workspaceId}::${repoPath}::${kind}`;
  if (loggedSiblingScanWarnings.has(key)) return;
  loggedSiblingScanWarnings.add(key);
  console.warn(
    `[workspace-merge] pending-sibling scan: ${reason} (further occurrences of this suppressed until restart)`,
  );
}
