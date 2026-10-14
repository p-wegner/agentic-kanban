// The verify jobs placed on workers right now (#1437), in their own module so session placement can
// count them against a worker's slot budget (#1456) without importing the runner (which imports the fleet).
import type { VerifyStage } from "@agentic-kanban/shared/lib/worker-verify-protocol";
import type { VerifyChainKind } from "./verify-placement.js";

/** One verify job as the watch view and /api/workers show it. */
export interface ActiveVerifyJob {
  jobId: string;
  workerId: string;
  workerName: string;
  kind: VerifyChainKind;
  sha: string;
  tier: string;
  stage: VerifyStage;
  filesDone?: number;
  filesTotal?: number;
  startedAt: string;
  /** #1465: the worker's socket dropped; the board is holding the job for the reconnect grace. */
  disconnectedAt?: string;
  /** #1465: the worker came back and the board re-attached to this still-placed job. */
  reattached?: boolean;
}

export const active = new Map<string, ActiveVerifyJob>();

/** Verify jobs in flight on workers right now (#1437). */
export function listActiveVerifyJobs(): ActiveVerifyJob[] {
  return [...active.values()];
}

/** How many verify jobs are in flight on one worker. */
export function verifyJobCountOnWorker(workerId: string): number {
  let n = 0;
  for (const j of active.values()) if (j.workerId === workerId) n++;
  return n;
}
