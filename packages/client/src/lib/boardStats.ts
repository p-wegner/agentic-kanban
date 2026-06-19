import type { StatusWithIssues } from "@agentic-kanban/shared";

/**
 * Pure board-summary aggregates derived from the active/archive columns.
 *
 * These derivations (totals, completion %, active-agent count, per-profile
 * counts) lived inline at the top of the `BoardStats` component and were the bulk
 * of its cyclomatic complexity. Pulled out here they are independently testable
 * and the component is left with just presentation + the lazy /stats fetch.
 */
export interface BoardStatsData {
  /** Active columns followed by archive columns, in order. */
  allColumns: StatusWithIssues[];
  /** Issue count across active (non-terminal) columns. */
  totalActive: number;
  /** Issue count across archive (Done/Cancelled) columns. */
  totalArchive: number;
  /** Grand total issue count. */
  total: number;
  doneCount: number;
  cancelledCount: number;
  /** Total excluding cancelled — the denominator for completion. */
  nonCancelledTotal: number;
  /** Done as a percentage of non-cancelled work (0 when there is none). */
  completionPct: number;
  /** Issues whose main workspace is currently active or under review. */
  activeWorkspaces: number;
  /** Count of active issues per agent profile name (tagged profile, else legacy claudeProfile). */
  profileCounts: Map<string, number>;
}

export function computeBoardStats(
  activeColumns: StatusWithIssues[],
  archiveColumns: StatusWithIssues[],
): BoardStatsData {
  const allColumns = [...activeColumns, ...archiveColumns];
  const totalActive = activeColumns.reduce((sum, col) => sum + col.count, 0);
  const totalArchive = archiveColumns.reduce((sum, col) => sum + col.count, 0);
  const total = totalActive + totalArchive;

  const doneCount = archiveColumns.find((c) => c.name === "Done")?.count ?? 0;
  const cancelledCount = archiveColumns.find((c) => c.name === "Cancelled")?.count ?? 0;
  const nonCancelledTotal = total - cancelledCount;
  const completionPct = nonCancelledTotal > 0 ? Math.round((doneCount / nonCancelledTotal) * 100) : 0;

  const activeWorkspaces = activeColumns.reduce(
    (sum, col) =>
      sum +
      col.issues.filter((i) => {
        const ws = i.workspaceSummary?.main;
        return ws?.status === "active" || ws?.status === "reviewing";
      }).length,
    0,
  );

  const profileCounts = new Map<string, number>();
  for (const col of activeColumns) {
    for (const issue of col.issues) {
      const wsMain = issue.workspaceSummary?.main;
      // Prefer the tagged profile, fall back to the legacy claudeProfile string.
      const profile = wsMain?.profile?.name ?? wsMain?.claudeProfile;
      if (profile) profileCounts.set(profile, (profileCounts.get(profile) ?? 0) + 1);
    }
  }

  return {
    allColumns,
    totalActive,
    totalArchive,
    total,
    doneCount,
    cancelledCount,
    nonCancelledTotal,
    completionPct,
    activeWorkspaces,
    profileCounts,
  };
}
