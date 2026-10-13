// #1451 - what this machine has free right now: RAM and the disk under the work root.
// Db-free (ships in the standalone worker binary). Used by the heartbeat and by `status`.

import { existsSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { readTier0Capacity, toWorkerCapacitySnapshot } from "@agentic-kanban/shared/lib/machine-capacity";
import type { WorkerCapacityInfo } from "@agentic-kanban/shared/lib/worker-protocol";

const GB = 1024 ** 3;

/** Free GB on the volume holding `path` (nearest existing parent when it is not created yet); undefined when unreadable. */
export function freeDiskGb(path: string): number | undefined {
  let dir = path;
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  try {
    const st = statfsSync(dir);
    return (st.bavail * st.bsize) / GB;
  } catch {
    return undefined;
  }
}

/** The heartbeat's capacity blob, now carrying total RAM and free work-root disk. Never throws. */
export function readWorkerCapacity(workRoot?: string): WorkerCapacityInfo {
  const snap = toWorkerCapacitySnapshot(readTier0Capacity());
  const disk = workRoot ? freeDiskGb(workRoot) : undefined;
  return { ...snap, ...(disk !== undefined ? { freeDiskGb: disk } : {}) };
}
