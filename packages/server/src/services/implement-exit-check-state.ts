/**
 * The implement-exit check's in-process state: which workspaces are being checked right now,
 * how many feedback turns each has been sent since its last green, and which ones the board
 * gave up on and marked for attention.
 *
 * In memory on purpose, like `monitor-gate-recall.ts`: no column is added to the widest table in
 * the schema for it (`workspaces` is pinned by `workspaces-table-width-ratchet.test.ts`). A restart
 * forgets it, and the worst case of forgetting is bounded: an in-flight check is simply not
 * resumed (the workspace is idle, the monitor relaunches the builder, its next exit checks again),
 * and a retry count starts over, so a workspace can receive at most one more round of feedback
 * turns per board process.
 *
 * Two readers outside the check itself:
 *  - the monitor's idle-workspace handler skips a workspace whose check is in flight or which is
 *    marked for attention, so it does not relaunch a builder the board is still judging;
 *  - the completion-state reconciler (#712) does not flip an attention-marked `blocked` workspace
 *    back to `idle`, which would otherwise undo the mark within one sweep.
 */

export interface ImplementExitAttention {
  reason: string;
  markedAt: string;
}

const inFlight = new Set<string>();
const feedbackTurns = new Map<string, number>();
const attention = new Map<string, ImplementExitAttention>();

export function markImplementExitCheckInFlight(workspaceId: string): void {
  inFlight.add(workspaceId);
}

export function clearImplementExitCheckInFlight(workspaceId: string): void {
  inFlight.delete(workspaceId);
}

export function isImplementExitCheckInFlight(workspaceId: string): boolean {
  return inFlight.has(workspaceId);
}

/** Feedback turns sent to this workspace's builder since its last green check. */
export function implementExitFeedbackTurns(workspaceId: string): number {
  return feedbackTurns.get(workspaceId) ?? 0;
}

export function noteImplementExitFeedbackTurn(workspaceId: string): number {
  const next = implementExitFeedbackTurns(workspaceId) + 1;
  feedbackTurns.set(workspaceId, next);
  return next;
}

export function markImplementExitAttention(workspaceId: string, value: ImplementExitAttention): void {
  attention.set(workspaceId, value);
}

export function getImplementExitAttention(workspaceId: string): ImplementExitAttention | undefined {
  return attention.get(workspaceId);
}

/** A green (or skipped) check: forget the retry count and any attention mark. */
export function resetImplementExitCheckState(workspaceId: string): void {
  feedbackTurns.delete(workspaceId);
  attention.delete(workspaceId);
}

/**
 * Whether automation must leave this workspace alone: its check is running, or the board marked it
 * for attention after the feedback cap. Returns the reason for the caller's log line, or null.
 */
export function implementExitHoldReason(workspaceId: string): string | null {
  if (inFlight.has(workspaceId)) return "its implement-exit check is running";
  const mark = attention.get(workspaceId);
  return mark ? `it needs attention after the implement-exit check: ${mark.reason}` : null;
}

/** Test seam: drop all state. */
export function resetAllImplementExitCheckStateForTests(): void {
  inFlight.clear();
  feedbackTurns.clear();
  attention.clear();
}
