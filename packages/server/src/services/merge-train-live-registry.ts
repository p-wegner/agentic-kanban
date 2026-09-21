/**
 * #1181 — the in-process registry of merge-train jobs that are LIVE right now.
 *
 * A train's whole lifecycle is one async generator (`runTrainStrategy` in
 * `merge-queue-train.ts`) with no session row, PID or heartbeat of its own, so the only thing
 * that knows a `merge_trains` row still has a job behind it is the process running that job.
 * `merge-train-reconciler.ts` was built on the boot-time truth that "nothing can be live yet"
 * — correct at boot, and wrong on every periodic sweep after it: measured 2026-09-16, a
 * 14-member train 8 minutes into a 28-minute gate was abandoned as stranded, re-assembled,
 * and the re-assembly then died waiting on the repo lock the live job still held.
 *
 * This module is that missing liveness signal. A run registers its row when the row is minted
 * and clears it in a `finally`; the reconciler's sweep takes a snapshot and skips any row (or
 * any same-project sibling) it finds here. At boot the registry is empty by construction, so
 * the boot pass keeps its "nothing can be live" rule without a special case.
 *
 * Module-level state on purpose: it is a fact about THIS process, exactly like the periodic
 * sweep handles in `startup/`. `snapshotLiveMergeTrains` hands out a copy so the decision
 * that reads it can stay pure.
 */

export interface LiveMergeTrain {
  trainId: string;
  label: string;
  projectId: string;
  /** Epoch ms when the job registered — for the "live (age Nm)" log line. */
  registeredAtMs: number;
  /**
   * #1203 — the real cancellation token for this job. `runTrainStrategy` creates one when it
   * registers the row and passes its `signal` into `runMergeTrain`, so an operator cancel can
   * `.abort()` this controller and have the in-flight gate's child process killed and the
   * bisect driver refuse to start another attempt, instead of only marking the DB row
   * `abandoned` while the job keeps running to completion (the #1153 gap).
   */
  abortController: AbortController;
}

/** Read-only view of the registry a sweep decides against. */
export type LiveMergeTrainSnapshot = ReadonlyMap<string, LiveMergeTrain>;

const live = new Map<string, LiveMergeTrain>();

/**
 * Register a train job as live. Idempotent for the same id (a re-register refreshes the entry
 * and mints a FRESH abort controller — a stale one from a previous registration of the same id
 * must never be reused, since its `abort()` may already have fired).
 */
export function registerLiveMergeTrain(entry: { trainId: string; label: string; projectId: string; nowMs?: number }): AbortController {
  const abortController = new AbortController();
  live.set(entry.trainId, {
    trainId: entry.trainId,
    label: entry.label,
    projectId: entry.projectId,
    registeredAtMs: entry.nowMs ?? Date.now(),
    abortController,
  });
  return abortController;
}

/** Clear a train job. Idempotent — safe from a `finally` that may run after an explicit clear. */
export function unregisterLiveMergeTrain(trainId: string): void {
  live.delete(trainId);
}

/**
 * Ask a live train's job to stop (#1203). A no-op — never an error — when the job is not
 * registered in THIS process: the row may belong to a job on another process (not today's
 * architecture, but the safe read), or may already have finished between the caller's read of
 * the row and this call. Returns whether a live job was actually signalled, so the caller
 * (the cancel route) can report `stoppedAfter: "current-attempt"` vs `"immediately"`.
 */
export function abortLiveMergeTrain(trainId: string): boolean {
  const entry = live.get(trainId);
  if (!entry) return false;
  entry.abortController.abort();
  return true;
}

export function isMergeTrainLive(trainId: string): boolean {
  return live.has(trainId);
}

/**
 * Is a train job for this `label` running in THIS process? (#1150) The repo lock's holder
 * string is `merge-train:<label>` — the label is all the lock layer has on hand while it logs
 * a contended wait, and it has no DB access to map a label back to a row id.
 */
export function isMergeTrainLabelLive(label: string): boolean {
  for (const entry of live.values()) {
    if (entry.label === label) return true;
  }
  return false;
}

/** A copy of the registry as of now — what the reconciler's sweep decides against. */
export function snapshotLiveMergeTrains(): LiveMergeTrainSnapshot {
  return new Map(live);
}

/** The live train for a project, if this process is running one. Pure over the snapshot. */
export function findLiveMergeTrainForProject(
  snapshot: LiveMergeTrainSnapshot,
  projectId: string,
): LiveMergeTrain | undefined {
  for (const entry of snapshot.values()) {
    if (entry.projectId === projectId) return entry;
  }
  return undefined;
}

/** Test seam — forget every live job, as a fresh process would. */
export function resetLiveMergeTrainRegistryForTests(): void {
  live.clear();
}
