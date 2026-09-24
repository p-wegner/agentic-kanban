import { useSyncExternalStore } from "react";
import { getMergeJobsSnapshot, subscribeMergeJobs, type TrackedMergeJob } from "../lib/mergeJobTracker.js";
import { describeMergeJobBadge, type MergeJobBadge } from "../lib/mergeJobBadge.js";
import { useNow } from "./usePoll.js";

export interface MergeJobStatus {
  /** The tracked merge for this workspace, or null when none is in flight (as far as the client knows). */
  tracked: TrackedMergeJob | null;
  /** True while a merge is tracked — the "joining the running merge" signal for a second click. */
  running: boolean;
  /** `Merging · verify · 3m12s · attempt 1`, or null when nothing is in flight. */
  badge: MergeJobBadge | null;
}

/**
 * Subscribe a component to the merge in flight for ONE workspace (#1250).
 *
 * The fetching lives in `lib/mergeJobTracker.ts` (a module store polled every few seconds
 * through the staggered scheduler), so this hook issues no request of its own: it reads the
 * store through `useSyncExternalStore` and re-renders once a second while a merge is tracked
 * so the badge's elapsed clock moves.
 */
export function useMergeJobStatus(wsId: string | null): MergeJobStatus {
  const snapshot = useSyncExternalStore(subscribeMergeJobs, getMergeJobsSnapshot, getMergeJobsSnapshot);
  const tracked = wsId ? (snapshot.get(wsId) ?? null) : null;
  const now = useNow(1000, tracked !== null);
  const badge = tracked ? describeMergeJobBadge(tracked.status, now) : null;
  return { tracked, running: tracked !== null, badge };
}
