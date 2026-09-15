/**
 * The monitor's own memory of gate verdicts it produced (#1161).
 *
 * `handleReviewingWorkspace`'s "reviewing+stopped" path runs the pre-merge gate directly via
 * `runGateWithEvidence` — it does NOT go through `mergeWorkspaceDeduped`/`startMergeJob`, so
 * none of `merge-job.service.ts`'s per-workspace attempt tracking (or its zombie/dedup guards)
 * ever sees these runs. A candidate whose gate genuinely fails therefore has nothing recording
 * that fact anywhere the monitor itself consults, and every cycle re-walks it from a blank
 * slate: same red gate, same ~5-minute `candidateTimeoutMs` overrun, same abandon.
 *
 * Two small pieces of in-memory state fix that, both scoped to THIS process — a restart
 * legitimately forgets them, exactly like `merge-job.service.ts`'s job map, because the worst
 * case of forgetting is one wasted re-gate, not a correctness bug:
 *
 *  - `lastFailedShaByWorkspace` — the branch sha a gate last FAILED at. Checked before paying
 *    for another full gate run; cleared the moment the branch moves (new commit / rebase) or
 *    the gate passes, so a real fix is never held back by a stale memory of the old failure.
 *  - `inFlightWorkspaceIds` — set while a monitor-initiated gate is still running (including
 *    one abandoned on timeout — the work keeps running detached, see
 *    `DEFAULT_MONITOR_CANDIDATE_TIMEOUT_MS`). A later cycle must not start a SECOND chain for
 *    the same workspace while the first is still out there.
 */

export interface FailedGateMemory {
  branchSha: string;
  failedAt: string;
  message: string;
}

const lastFailedShaByWorkspace = new Map<string, FailedGateMemory>();
const inFlightWorkspaceIds = new Set<string>();

/** The sha a previous monitor-run gate failed at for this workspace, if any is remembered. */
export function getLastFailedGate(workspaceId: string): FailedGateMemory | undefined {
  return lastFailedShaByWorkspace.get(workspaceId);
}

/** Record (or overwrite) the sha a monitor-run gate just failed at. */
export function recordFailedGate(workspaceId: string, memory: FailedGateMemory): void {
  lastFailedShaByWorkspace.set(workspaceId, memory);
}

/** Forget a remembered failure — the branch moved, or the gate has since passed. */
export function clearFailedGate(workspaceId: string): void {
  lastFailedShaByWorkspace.delete(workspaceId);
}

/** Whether a monitor-initiated gate is still running (or was abandoned mid-flight) for this workspace. */
export function isGateInFlight(workspaceId: string): boolean {
  return inFlightWorkspaceIds.has(workspaceId);
}

/** Mark a monitor-initiated gate as started. Idempotent. */
export function markGateInFlight(workspaceId: string): void {
  inFlightWorkspaceIds.add(workspaceId);
}

/** Mark a monitor-initiated gate as finished — including a late finish after abandonment. */
export function clearGateInFlight(workspaceId: string): void {
  inFlightWorkspaceIds.delete(workspaceId);
}

/** Test-only: reset all recalled state between suites. */
export function resetMonitorGateRecallForTests(): void {
  lastFailedShaByWorkspace.clear();
  inFlightWorkspaceIds.clear();
}
