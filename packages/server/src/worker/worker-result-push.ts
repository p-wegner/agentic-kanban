// #750/#870/#1461: settle one finished session's result push — clean up on success, retain on
// failure — and return the exit code the board should see. Extracted from createWorkerAgentRunner
// (nloc ratchet). Node builtins + sibling worker modules only (worker-cli-isolation).

import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { workerLog } from "./worker-updater.js";
import { removeUndelivered } from "./worker-undelivered.js";
import type { PendingResult, createUndeliveredStore } from "./worker-undelivered-retry.js";
import type { WorkerCheckout } from "./worker-repo.js";

export interface SettleResultPushDeps {
  undelivered: ReturnType<typeof createUndeliveredStore>;
  abandonedPushes: Set<string>;
  workRoot: string;
  cleanup: (checkout: WorkerCheckout) => Promise<void>;
}

/** Never throws: this runs detached off the child's exit event (#870). */
export async function settleResultPush(
  { undelivered, abandonedPushes, workRoot, cleanup }: SettleResultPushDeps,
  sessionId: string,
  pending: PendingResult,
  exitCode: number | null,
): Promise<number | null> {
  const failedExit = exitCode === 0 || exitCode === null ? 1 : exitCode;
  try {
    const outcome = await undelivered.pushWithRetry(sessionId, pending);
    if (outcome.ok && abandonedPushes.has(sessionId)) {
      // #1461: the drain already recorded this as undelivered; it did land after all, so
      // clear the record. The checkout is left for the next start's reaper (nothing holds it).
      removeUndelivered(workRoot, sessionId);
    } else if (outcome.ok) {
      try {
        await cleanup(pending.checkout);
      } catch { /* best-effort */ }
    } else if (abandonedPushes.has(sessionId)) {
      return failedExit;
    } else {
      // #750/#775 item 2: the checkout is NOT removed — a failed push used to cost the whole
      // run, since the commits lived only on a branch nothing enumerates.
      undelivered.retain(sessionId, pending, outcome);
      return failedExit;
    }
  } catch (err) {
    // #870: NOTHING on this path may escape — one failed push once took the whole daemon down.
    // Retain the result like any exhausted retry and hand it to the #871 undelivered tracking.
    const message = errorMessage(err);
    workerLog(`[worker] result push path failed unexpectedly (daemon staying up): sessionId=${sessionId}: ${message}`);
    try {
      undelivered.retain(sessionId, pending, { ok: false, attempts: 0, lastError: message });
    } catch (retainErr) {
      workerLog(`[worker] could not retain the unpushed result: sessionId=${sessionId}`, retainErr);
    }
    return failedExit;
  }
  return exitCode;
}
