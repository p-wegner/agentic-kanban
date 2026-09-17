/**
 * #1181 — which `merge_trains` rows have a LIVE in-process job right now.
 *
 * A train's whole lifecycle runs inside one in-process async generator
 * (`runTrainStrategy` in `merge-queue-train.ts`) — there is no PID/heartbeat for it the way a
 * workspace agent has, so "is this row live" cannot be answered by reading the DB row alone.
 * `startup/merge-train-reconciler.ts`'s BOOT pass has always been correct to treat every
 * `assembling`/`gating` row as orphaned, since at boot nothing has started yet in this process.
 * Its PERIODIC sweep (every `SWEEP_INTERVAL_MS`) is a different question: a row that is still
 * `assembling`/`gating` 10 minutes in may simply be a slow gate still running in THIS process,
 * and the sweep must not treat "still running" as "found stranded".
 *
 * This registry is what lets the sweep tell the two apart: `runTrainStrategy` registers its
 * trainId the moment `beginMergeTrain` succeeds and unregisters it in a `finally`, so the set
 * reflects exactly the jobs this process currently holds open.
 */

const liveTrainIds = new Set<string>();

/** Mark a train id as having a live in-process job. Call once assembly has actually started. */
export function registerLiveMergeTrain(trainId: string): void {
  liveTrainIds.add(trainId);
}

/** Clear a train id's live marker. Always call from a `finally`, win or lose. */
export function unregisterLiveMergeTrain(trainId: string): void {
  liveTrainIds.delete(trainId);
}

/** Is this train id currently running in this process? */
export function isMergeTrainLive(trainId: string): boolean {
  return liveTrainIds.has(trainId);
}

/** Test-only: reset between suites so one test's leaked registration can't affect another. */
export function resetLiveMergeTrainRegistry(): void {
  liveTrainIds.clear();
}
