import { useMergeJobStatus } from "../hooks/useMergeJobStatus.js";
import type { MergeJobBadge as MergeJobBadgeModel } from "../lib/mergeJobBadge.js";

/**
 * `Merging · verify · 3m12s · attempt 1` (#1250) — rendered wherever a Merge button lives,
 * for as long as `lib/mergeJobTracker.ts` tracks a merge for the workspace. Null otherwise,
 * so it costs nothing on the cards that are not merging.
 */
export function MergeJobBadge({ wsId, className = "" }: { wsId: string; className?: string }) {
  const { badge } = useMergeJobStatus(wsId);
  return badge ? <MergeJobBadgeView badge={badge} className={className} /> : null;
}

/** The pure half, so a fixture job renders without the store. */
export function MergeJobBadgeView({ badge, className = "" }: { badge: MergeJobBadgeModel; className?: string }) {
  return (
    <span
      data-testid="merge-job-badge"
      title={badge.title}
      className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300 ${className}`}
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse" />
      {badge.label}
    </span>
  );
}
