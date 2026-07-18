import { useMemo } from "react";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import type { LiveSessionStats } from "../lib/useBoardEvents.js";
import { aggregateFleetLiveStats } from "../lib/fleetLiveStats.js";
import type { FleetAgentInput, FleetLiveStatsAggregate } from "../lib/fleetLiveStats.js";

/**
 * A workspace is "live" while its main workspace is actively running an agent.
 * Mirrors the liveness gate in `useBoardLiveHandlers` (`active` / `fixing`).
 */
const ACTIVE_STATUSES = new Set(["active", "fixing"]);

interface UseFleetLiveStatsParams {
  /**
   * Per-issue live agent stats from the board-events WS, owned by
   * `useBoardRealtimeController` (already scoped to the active project and
   * pruned to active workspaces). We aggregate this rather than opening a second
   * WebSocket — the board mounts exactly one `useBoardEvents` connection.
   */
  liveStats: Record<string, LiveSessionStats>;
  /** Current board columns — source of issue metadata + authoritative liveness. */
  columns: StatusWithIssues[];
  /** Derived last-activity/tool per issue (`useBoardRealtimeController.sessionActivity`). */
  sessionActivity: Record<string, string>;
}

/**
 * Aggregate the fleet's live token/cost burn from the per-issue live-stats map.
 * Joins each live entry with its issue metadata + last tool, gates on workspace
 * liveness, and reduces to fleet totals + per-provider/per-model splits.
 */
export function useFleetLiveStats({
  liveStats,
  columns,
  sessionActivity,
}: UseFleetLiveStatsParams): FleetLiveStatsAggregate {
  return useMemo(() => {
    // Index issues by id once for metadata + liveness lookups.
    const issueById = new Map<string, StatusWithIssues["issues"][number]>();
    for (const col of columns) {
      for (const issue of col.issues) issueById.set(issue.id, issue);
    }

    const inputs: FleetAgentInput[] = Object.entries(liveStats).map(([issueId, stats]) => {
      const issue = issueById.get(issueId);
      const main = issue?.workspaceSummary?.main;
      // liveStats is already pruned to active issues, but re-check against the
      // board's current status so an agent that just went idle drops out.
      const active = !!main && ACTIVE_STATUSES.has(main.status);
      return {
        issueId,
        issueNumber: issue?.issueNumber ?? null,
        title: issue?.title ?? "Untitled",
        model: stats.model || main?.model || "unknown",
        contextTokens: stats.contextTokens,
        toolUses: stats.toolUses,
        subagentCount: stats.subagentCount,
        active,
        lastTool: sessionActivity[issueId] ?? main?.lastTool ?? null,
      };
    });

    return aggregateFleetLiveStats(inputs);
  }, [liveStats, columns, sessionActivity]);
}
