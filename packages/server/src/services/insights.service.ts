import type { Database } from "../db/index.js";
import { getInsightsSessionRows } from "../repositories/session.repository.js";
import { getActiveWorkspacesForProject } from "../repositories/workspace.repository.js";
import { accumulateInsightsRow, createInsightsAccumulator } from "./insights/accumulator.js";
import {
  createAggregateBucket,
  finalizeAggregate,
  startOfUtcDay,
  addUtcDays,
  type AccumulateContext,
  type InsightsAccumulator,
  type FinalizedAggregateFields,
} from "./insights/types.js";

export {
  createInsightsAccumulator,
  accumulateInsightsRow,
  type AccumulateContext,
  type InsightsAccumulator,
};

const RANGE_DAYS = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
} as const;

export type InsightsRange = keyof typeof RANGE_DAYS | "all";

export interface InsightsData {
  bySkill: Array<FinalizedAggregateFields & {
    skillId: string | null;
    skillName: string;
  }>;
  byModel: Array<FinalizedAggregateFields & {
    model: string;
  }>;
  byIssueType: Array<{
    issueType: string;
    sessionCount: number;
    successCount: number;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  }>;
  byPriority: Array<{
    priority: string;
    sessionCount: number;
    successCount: number;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  }>;
  timeSeries: Array<{
    date: string;
    sessionCount: number;
    successCount: number;
    totalCostUsd: number;
  }>;
  topExpensive: Array<{
    sessionId: string;
    workspaceId: string;
    issueId: string;
    issueNumber: number | null;
    issueTitle: string;
    skillName: string | null;
    model: string | null;
    totalCostUsd: number;
    totalTokens: number;
    numTurns: number;
    durationMs: number;
    success: boolean;
    startedAt: string;
  }>;
  byProviderProfile: Array<FinalizedAggregateFields & {
    provider: string;
    profile: string;
    activeWorkspaceCount: number;
  }>;
  /**
   * Leaderboard of the issues that consumed the most context tokens over a
   * FIXED last-7-days window (independent of the panel's range selector).
   * "Context tokens" follows the codebase convention: the stats'
   * `contextTokens` if present, else `inputTokens + cacheReadTokens` — the
   * tokens that actually occupy the model's context window, not output. (#751)
   */
  topContextConsumers: {
    /** Inclusive ISO start of the 7-day window the leaderboard is computed over. */
    windowFrom: string;
    /** Total context tokens across every session in the window (the bar denominator). */
    totalContextTokens: number;
    rows: Array<{
      issueId: string;
      issueNumber: number | null;
      issueTitle: string;
      sessionCount: number;
      contextTokens: number;
      totalCostUsd: number;
    }>;
  };
  friction: {
    /** Sessions in the window that have persisted friction stats. */
    sessionsWithFriction: number;
    /** Fraction of sessions covered by friction stats (0-1). Lower = more historical/backfill needed. */
    coverage: number;
    totalToolCalls: number;
    failedToolCalls: number;
    failPct: number;
    errorTotal: number;
    /** Per-tool call/failure leaderboard, sorted by failures then calls. */
    byTool: Array<{ tool: string; calls: number; failed: number; failPct: number }>;
    /** Commands repeated across sessions (summed counts), a wasted-turn signal. */
    topRepeatedCommands: Array<{ command: string; count: number; sessions: number }>;
    /** Skills ranked worst-first by success rate then turns-per-success. */
    worstSkills: Array<{
      skillName: string;
      sessionCount: number;
      successRate: number;
      turnsPerSuccess: number;
      failedToolCalls: number;
      totalCostUsd: number;
    }>;
  };
  totals: {
    sessionCount: number;
    successCount: number;
    totalCostUsd: number;
    totalTokens: number;
    dateFrom: string;
    dateTo: string;
  };
}

export function parseRange(value: string | undefined): InsightsRange {
  if (value === "7d" || value === "30d" || value === "90d" || value === "all") {
    return value;
  }
  return "30d";
}

export interface ComputeInsightsParams {
  projectId: string;
  range: InsightsRange;
  /**
   * `hours=N` gives an exact sub-day / arbitrary window (e.g. last 48h), taking
   * precedence over the day-bucketed `range`. Used by the fleet-friction analysis
   * workflow which is typically time-scoped to the last 1-2 days. Ignored when not
   * a finite positive number.
   */
  hours?: number;
  /** Injectable clock for deterministic tests; defaults to the current time. */
  now?: Date;
}

/**
 * Compute the full Insights panel dataset for a project over a time window.
 * Pure application logic (transport-free): the route adapter parses query params
 * and serializes the returned {@link InsightsData}.
 */
export async function computeInsights(database: Database, params: ComputeInsightsParams): Promise<InsightsData> {
  const { projectId, range } = params;

  const now = params.now ?? new Date();
  const useHours = params.hours !== undefined && Number.isFinite(params.hours) && params.hours > 0;

  const dateTo = now.toISOString();
  const queryDateFrom = useHours
    ? new Date(now.getTime() - (params.hours as number) * 60 * 60 * 1000)
    : range === "all"
      ? null
      : startOfUtcDay(addUtcDays(now, -(RANGE_DAYS[range] - 1)));

  const rows = await getInsightsSessionRows(
    projectId,
    queryDateFrom ? queryDateFrom.toISOString() : null,
    database,
  );

  // Fetch active workspace IDs grouped by provider/profile for the ledger
  const activeWorkspaceRows = await getActiveWorkspacesForProject(projectId, database);

  const acc = createInsightsAccumulator();

  // Per-issue context-token leaderboard over a FIXED last-7-days window,
  // independent of the panel's range selector (the #751 feature is explicitly
  // "Top context consumers in the last 7 days"). When the selected range is
  // wider (30d/90d/all) we still only count sessions inside this window.
  const contextWindowFrom = startOfUtcDay(addUtcDays(now, -(RANGE_DAYS["7d"] - 1)));


  // Pre-build a map from provider/profile key to active workspace IDs so the
  // ledger shows currently-running workspace counts separately from session history.
  const activeWorkspaceByKey = new Map<string, { wsIds: Set<string>; provider: string; profile: string }>();
  for (const ws of activeWorkspaceRows) {
    const provider = ws.provider ?? "unknown";
    const profile = ws.claudeProfile ?? "";
    const key = `${provider}::${profile}`;
    const existing = activeWorkspaceByKey.get(key);
    if (existing) {
      existing.wsIds.add(ws.id);
    } else {
      activeWorkspaceByKey.set(key, { wsIds: new Set([ws.id]), provider, profile });
    }
  }


  const accCtx: AccumulateContext = { fallbackStartedAtIso: dateTo, contextWindowFromIso: contextWindowFrom.toISOString() };
  for (const row of rows) accumulateInsightsRow(acc, row, accCtx);

  const {
    bySkill, byModel, byIssueType, byPriority, byProviderProfile, timeSeries,
    topExpensive, contextByIssue, frictionByTool, repeatedCommandAgg,
    sessionCount, successCount, earliestStartedAt, totalCostUsd, totalTokens,
    contextWindowTotalTokens, sessionsWithFriction, frictionTotalToolCalls,
    frictionFailedToolCalls, frictionErrorTotal,
  } = acc;

  const effectiveDateFrom = range === "all"
    ? (earliestStartedAt ?? dateTo)
    : (queryDateFrom?.toISOString() ?? dateTo);
  const startDate = startOfUtcDay(new Date(effectiveDateFrom));
  const endDate = startOfUtcDay(new Date(dateTo));
  const filledTimeSeries: InsightsData["timeSeries"] = [];

  for (let cursor = new Date(startDate); cursor <= endDate; cursor = addUtcDays(cursor, 1)) {
    const key = cursor.toISOString().slice(0, 10);
    filledTimeSeries.push(timeSeries.get(key) ?? {
      date: key,
      sessionCount: 0,
      successCount: 0,
      totalCostUsd: 0,
    });
  }

  // Merge active workspace IDs into buckets. Also ensure buckets exist for
  // provider/profile combos with active workspaces but no sessions in the range.
  for (const [key, { wsIds, provider, profile }] of activeWorkspaceByKey) {
    const existing = byProviderProfile.get(key);
    if (existing) {
      for (const id of wsIds) existing.activeWorkspaceIds.add(id);
    } else {
      byProviderProfile.set(key, {
        provider,
        profile,
        activeWorkspaceIds: wsIds,
        ...createAggregateBucket(),
      });
    }
  }

  const bySkillFinalized = [...bySkill.values()]
    .map((bucket) => ({
      skillId: bucket.skillId,
      skillName: bucket.skillName,
      ...finalizeAggregate(bucket),
    }))
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd || b.sessionCount - a.sessionCount || a.skillName.localeCompare(b.skillName));

  // worstSkills: rank skills with enough volume worst-first by success rate,
  // then by turns-per-success (more turns per landed change = more friction).
  const worstSkills = bySkillFinalized
    .filter((s) => s.sessionCount >= 2)
    .map((s) => ({
      skillName: s.skillName,
      sessionCount: s.sessionCount,
      successRate: s.sessionCount > 0 ? s.successCount / s.sessionCount : 0,
      turnsPerSuccess: s.successCount > 0 ? s.totalTurns / s.successCount : s.totalTurns,
      failedToolCalls: s.failedToolCalls,
      totalCostUsd: s.totalCostUsd,
    }))
    .sort((a, b) => a.successRate - b.successRate || b.turnsPerSuccess - a.turnsPerSuccess)
    .slice(0, 10);

  const frictionBlock: InsightsData["friction"] = {
    sessionsWithFriction,
    coverage: sessionCount > 0 ? sessionsWithFriction / sessionCount : 0,
    totalToolCalls: frictionTotalToolCalls,
    failedToolCalls: frictionFailedToolCalls,
    failPct: frictionTotalToolCalls > 0 ? Math.round((100 * frictionFailedToolCalls) / frictionTotalToolCalls) : 0,
    errorTotal: frictionErrorTotal,
    byTool: [...frictionByTool.entries()]
      .map(([tool, { calls, failed }]) => ({
        tool,
        calls,
        failed,
        failPct: calls > 0 ? Math.round((100 * failed) / calls) : 0,
      }))
      .sort((a, b) => b.failed - a.failed || b.calls - a.calls || a.tool.localeCompare(b.tool))
      .slice(0, 20),
    topRepeatedCommands: [...repeatedCommandAgg.entries()]
      .map(([command, { count, sessions: ses }]) => ({ command, count, sessions: ses }))
      .sort((a, b) => b.count - a.count || b.sessions - a.sessions)
      .slice(0, 15),
    worstSkills,
  };

  const response: InsightsData = {
    bySkill: bySkillFinalized,
    byModel: [...byModel.values()]
      .map((bucket) => ({
        model: bucket.model,
        ...finalizeAggregate(bucket),
      }))
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd || b.sessionCount - a.sessionCount || a.model.localeCompare(b.model)),
    byIssueType: [...byIssueType.values()]
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd || b.sessionCount - a.sessionCount || a.issueType.localeCompare(b.issueType)),
    byPriority: [...byPriority.values()]
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd || b.sessionCount - a.sessionCount || a.priority.localeCompare(b.priority)),
    byProviderProfile: [...byProviderProfile.values()]
      .map((bucket) => ({
        provider: bucket.provider,
        profile: bucket.profile,
        activeWorkspaceCount: bucket.activeWorkspaceIds.size,
        ...finalizeAggregate(bucket),
      }))
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd || b.sessionCount - a.sessionCount || a.provider.localeCompare(b.provider) || a.profile.localeCompare(b.profile)),
    timeSeries: filledTimeSeries,
    topExpensive: topExpensive
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd || b.totalTokens - a.totalTokens || a.startedAt.localeCompare(b.startedAt))
      .slice(0, 10),
    topContextConsumers: {
      windowFrom: contextWindowFrom.toISOString(),
      totalContextTokens: contextWindowTotalTokens,
      rows: [...contextByIssue.values()]
        .filter((row) => row.contextTokens > 0)
        .sort((a, b) => b.contextTokens - a.contextTokens
          || b.sessionCount - a.sessionCount
          || (a.issueNumber ?? 0) - (b.issueNumber ?? 0))
        .slice(0, 10),
    },
    friction: frictionBlock,
    totals: {
      sessionCount,
      successCount,
      totalCostUsd,
      totalTokens,
      dateFrom: effectiveDateFrom,
      dateTo,
    },
  };

  return response;
}
