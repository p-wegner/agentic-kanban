/**
 * The window verdict for one tick, with the inconclusive-retry ramp (#1727, #1741) folded in.
 * Split out of `auto-merge-orchestrator.ts` to keep `createAutoMergeOrchestrator` under the
 * function-nloc ratchet.
 */
import type { Database } from "../db/index.js";
import { listRecentMergeTrainsForProject } from "../repositories/merge-train.repository.js";
import { decideInconclusiveRetry, logInconclusiveExhausted } from "./merge-queue-train-inconclusive.js";
import { decideMergeTrainRelease, type MergeTrainWindowVerdict, type MergeTrainWindowConfig } from "./merge-train-window.js";
import { verifyChainSemaphoreActive } from "./verify-chain-semaphore.js";

export async function evaluateTrainWindowVerdict(args: {
  projectId: string;
  ids: string[];
  firstSeenAt: string;
  config: MergeTrainWindowConfig;
  nowMs: number;
  heldUntilMs?: number | null;
  releaseRequested: boolean;
  database: Database;
}): Promise<MergeTrainWindowVerdict> {
  const { projectId, ids, firstSeenAt, config, nowMs, database } = args;
  // #1727: an inconclusive train judged nothing - its retry departs on this tick, not after a new max_wait.
  // #1741: repeated inconclusive abandons wait a 15/30/60 min ramp, then hold as inconclusive_exhausted.
  const inc = decideInconclusiveRetry(ids, await listRecentMergeTrainsForProject(projectId, 8, database).catch(() => []), nowMs);
  if (inc.kind === "exhausted") logInconclusiveExhausted(projectId, inc);
  return decideMergeTrainRelease({ pendingIds: ids, firstSeenAt }, config, nowMs, {
    gateBusy: verifyChainSemaphoreActive() > 0,
    heldUntilMs: args.heldUntilMs,
    releaseRequested: args.releaseRequested,
    inconclusiveRetry: inc.kind === "retry",
    inconclusiveHold: inc.kind === "exhausted" ? "inconclusive_exhausted" : inc.kind === "backoff" ? "inconclusive_backoff" : undefined,
  });
}
