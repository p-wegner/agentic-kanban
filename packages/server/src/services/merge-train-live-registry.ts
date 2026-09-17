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
}

/** Read-only view of the registry a sweep decides against. */
export type LiveMergeTrainSnapshot = ReadonlyMap<string, LiveMergeTrain>;

const live = new Map<string, LiveMergeTrain>();

/** Register a train job as live. Idempotent for the same id (a re-register refreshes the entry). */
export function registerLiveMergeTrain(entry: { trainId: string; label: string; projectId: string; nowMs?: number }): void {
  live.set(entry.trainId, {
    trainId: entry.trainId,
    label: entry.label,
    projectId: entry.projectId,
    registeredAtMs: entry.nowMs ?? Date.now(),
  });
}

/** Clear a train job. Idempotent — safe from a `finally` that may run after an explicit clear. */
export function unregisterLiveMergeTrain(trainId: string): void {
  live.delete(trainId);
}

export function isMergeTrainLive(trainId: string): boolean {
  return live.has(trainId);
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
