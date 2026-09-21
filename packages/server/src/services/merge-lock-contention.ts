/**
 * #1151 — the "contention is not a failure" branch, factored out of both
 * `merge-queue.service.ts` and `monitor-cycle-actions.ts` so each stays under the
 * `function-nloc-ratchet` (#800) baseline. Both callers hit the exact same fact once a merge
 * is refused for lock contention: skip it plainly, log/yield a `lock_contention` reason, and
 * never touch the fix-and-merge / conflict-reconciler escalation or the merge backoff — see
 * `isLockContentionFailure` in `workspace-merge-gate.ts` for why.
 */
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { isLockContentionFailure, isPreMergeGateFailure } from "./workspace-merge-gate.js";

/** The reason string both callers attach to a lock-contention skip/log entry. */
export function lockContentionReason(err: unknown, prefix = "lock_contention"): string {
  return `${prefix}: ${errorMessage(err)}`;
}

type LockContentionSkipEvent = {
  type: "skipped";
  workspaceId: string;
  issueNumber: number | null;
  issueTitle: string;
  reason: string;
};

/**
 * The queue's whole lock-contention carve-out: `null` when `err` is not a lock-contention
 * refusal, else the "skipped" event to yield — having already recorded `workspaceId` on
 * `skipped` (the queue's own running list), so the queue's catch block need only branch on
 * the result and `yield` it.
 */
export function lockContentionSkipEvent(args: {
  workspaceId: string;
  issueNumber: number | null;
  issueTitle: string;
  err: unknown;
  skipped: string[];
}): LockContentionSkipEvent | null {
  if (!isLockContentionFailure(args.err)) return null;
  args.skipped.push(args.workspaceId);
  return {
    type: "skipped",
    workspaceId: args.workspaceId,
    issueNumber: args.issueNumber,
    issueTitle: args.issueTitle,
    reason: lockContentionReason(args.err),
  };
}

/**
 * The queue's pre-existing pre-merge-gate carve-out (#170/#638), same shape as
 * {@link lockContentionSkipEvent} — moved here alongside it so both single-purpose skip
 * checks live beside the same `Database`-free queue-event vocabulary, and so
 * `createMergeQueueService` (the `function-nloc-ratchet` #800 baseline) has headroom for the
 * #1151 carve-out without either one growing past its listed baseline.
 */
export function preMergeGateSkipEvent(args: {
  workspaceId: string;
  issueNumber: number | null;
  issueTitle: string;
  err: unknown;
  skipped: string[];
}): LockContentionSkipEvent | null {
  if (!isPreMergeGateFailure(args.err)) return null;
  args.skipped.push(args.workspaceId);
  return {
    type: "skipped",
    workspaceId: args.workspaceId,
    issueNumber: args.issueNumber,
    issueTitle: args.issueTitle,
    reason: `verify_failed: ${errorMessage(args.err)}`,
  };
}

/**
 * The monitor path's full handling of a lock-contention refusal: warn, log the skip as a
 * failed (but not fix-and-merge'd) merge attempt. Returns nothing — callers `return` right
 * after invoking this, same as the inline branch it replaces.
 */
export function logMonitorLockContentionSkip(args: {
  wsId: string;
  issueId: string;
  mergeError: string;
  logAction: (
    action: "merge",
    workspaceId: string,
    issueId: string,
    extra: { endpoint: string; responseSummary: string; verificationResult: "failed" },
  ) => void;
}): void {
  console.warn(
    `[monitor] merge for workspace ${args.wsId} was refused for lock contention — NOT routing to fix-and-merge (#1151): ${args.mergeError}`,
  );
  args.logAction("merge", args.wsId, args.issueId, {
    endpoint: `POST /api/workspaces/${args.wsId}/merge`,
    responseSummary: `lock_contention (no fix-and-merge fallback): ${args.mergeError.slice(0, 160)}`,
    verificationResult: "failed",
  });
}
