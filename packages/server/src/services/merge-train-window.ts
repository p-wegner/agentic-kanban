/**
 * Merge train batching window (#905).
 *
 * The 30s auto-merge orchestrator tick used to land whatever was ready on the very tick it
 * became ready — a train of size 1 whenever candidates trickled in one at a time, which is
 * `trainEligible`'s floor (`order.length >= 2`) failing on almost every tick and the queue
 * falling back to the per-ticket path it exists to amortize away. This module is the pure
 * decision of WHEN to stop collecting and release what has accumulated so far as one train:
 * once it reaches `train_max_size_<projectId>` (default 4) or has been waiting
 * `train_max_wait_ms_<projectId>` (default 10 min), whichever comes first.
 *
 * Kept pure and synchronous per the `decision function` kind (#585) — the accumulator state
 * it reads (how many are waiting, since when) is assembled by the orchestrator from the DB;
 * this function only judges it.
 */

export interface MergeTrainWindowState {
  /** Ready workspace ids currently held back, waiting for the window to close. */
  pendingIds: string[];
  /** ISO timestamp the FIRST of the current pending set became ready. */
  firstSeenAt: string;
}

export interface MergeTrainWindowConfig {
  /** `train_max_size_<projectId>` — release as soon as the pending set reaches this size. */
  maxSize: number;
  /** `train_max_wait_ms_<projectId>` — release once the oldest pending member has waited this long, regardless of size. */
  maxWaitMs: number;
}

export type MergeTrainWindowVerdict =
  | { release: true; reason: "max_size" | "max_wait" }
  | { release: false; reason: "accumulating" };

/**
 * The batching-window default size (#905's `standard` risk-posture row). `trainEligible`
 * additionally requires >=2 members, so 1 would never actually release a train — but a batch
 * of exactly 1 is deliberately allowed to accumulate here rather than being special-cased,
 * since a size-1 "train" degrades to the existing sequential path with no change needed.
 */
export const DEFAULT_TRAIN_MAX_SIZE = 4;

/** `standard` risk-posture default (docs/proposals/2026-08-25-risk-posture-and-merge-train.md §3). */
export const DEFAULT_TRAIN_MAX_WAIT_MS = 10 * 60 * 1000;

/**
 * Should the batching window release its pending set as one train right now?
 *
 * `nowMs` is injected (not `Date.now()`) so this stays a pure, clock-independent decision —
 * see the root CLAUDE.md's time-injection convention.
 */
export function decideMergeTrainRelease(
  state: MergeTrainWindowState,
  config: MergeTrainWindowConfig,
  nowMs: number,
): MergeTrainWindowVerdict {
  if (state.pendingIds.length >= config.maxSize) {
    return { release: true, reason: "max_size" };
  }
  const waitedMs = nowMs - new Date(state.firstSeenAt).getTime();
  if (waitedMs >= config.maxWaitMs) {
    return { release: true, reason: "max_wait" };
  }
  return { release: false, reason: "accumulating" };
}
