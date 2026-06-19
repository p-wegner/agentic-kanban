import type { SessionFrictionStats } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import { getInsightsSessionRows } from "../repositories/session.repository.js";
import { getActiveWorkspacesForProject } from "../repositories/workspace.repository.js";

const RANGE_DAYS = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
} as const;

export type InsightsRange = keyof typeof RANGE_DAYS | "all";

interface ParsedSessionStats {
  durationMs: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  model: string;
  success: boolean;
  agentSummary?: string;
  cacheReadTokens?: number;
  contextTokens?: number;
  friction?: SessionFrictionStats;
}

interface AggregateBucket {
  sessionCount: number;
  successCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTurns: number;
  durations: number[];
  // Friction roll-up (only from sessions that have persisted friction stats).
  sessionsWithFriction: number;
  totalToolCalls: number;
  failedToolCalls: number;
  errorCount: number;
}

interface SkillBucket extends AggregateBucket {
  skillId: string | null;
  skillName: string;
}

interface ModelBucket extends AggregateBucket {
  model: string;
}

interface IssueTypeBucket {
  issueType: string;
  sessionCount: number;
  successCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

interface PriorityBucket {
  priority: string;
  sessionCount: number;
  successCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

interface ProviderProfileBucket extends AggregateBucket {
  provider: string;
  profile: string;
  activeWorkspaceIds: Set<string>;
}

interface TimeSeriesBucket {
  date: string;
  sessionCount: number;
  successCount: number;
  totalCostUsd: number;
}

interface FinalizedAggregateFields {
  sessionCount: number;
  successCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTurns: number;
  durationsMsP50: number;
  durationsMsP95: number;
  avgDurationMs: number;
  sessionsWithFriction: number;
  totalToolCalls: number;
  failedToolCalls: number;
  errorCount: number;
}

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

function parseStats(raw: string | null): ParsedSessionStats | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ParsedSessionStats>;
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      durationMs: Number(parsed.durationMs ?? 0),
      totalCostUsd: Number(parsed.totalCostUsd ?? 0),
      inputTokens: Number(parsed.inputTokens ?? 0),
      outputTokens: Number(parsed.outputTokens ?? 0),
      numTurns: Number(parsed.numTurns ?? 0),
      model: typeof parsed.model === "string" ? parsed.model : "",
      success: parsed.success === true,
      agentSummary: typeof parsed.agentSummary === "string" ? parsed.agentSummary : undefined,
      cacheReadTokens: Number(parsed.cacheReadTokens ?? 0),
      contextTokens: Number(parsed.contextTokens ?? 0),
      friction: parsed.friction && typeof parsed.friction === "object" ? parsed.friction : undefined,
    };
  } catch {
    return null;
  }
}

function isSuccessful(stats: ParsedSessionStats | null, exitCode: string | null) {
  return !!stats && (stats.success === true || exitCode === "0");
}

/**
 * Context tokens for a session = the tokens that occupy the model's context
 * window. Mirrors the `contextTokens || inputTokens + cacheReadTokens`
 * convention used in workspace-summary / session-stats / workspace.repository.
 */
function contextTokensFor(stats: ParsedSessionStats | null): number {
  if (!stats) return 0;
  const explicit = stats.contextTokens ?? 0;
  return explicit || (stats.inputTokens + (stats.cacheReadTokens ?? 0));
}

function createAggregateBucket(): AggregateBucket {
  return {
    sessionCount: 0,
    successCount: 0,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTurns: 0,
    durations: [],
    sessionsWithFriction: 0,
    totalToolCalls: 0,
    failedToolCalls: 0,
    errorCount: 0,
  };
}

function applyAggregate(bucket: AggregateBucket, stats: ParsedSessionStats | null, success: boolean) {
  bucket.sessionCount += 1;
  if (success) bucket.successCount += 1;
  if (!stats) return;

  bucket.totalCostUsd += stats.totalCostUsd;
  bucket.totalInputTokens += stats.inputTokens;
  bucket.totalOutputTokens += stats.outputTokens;
  bucket.totalTurns += stats.numTurns;
  bucket.durations.push(stats.durationMs);

  if (stats.friction) {
    bucket.sessionsWithFriction += 1;
    bucket.totalToolCalls += stats.friction.totalToolCalls;
    bucket.failedToolCalls += stats.friction.failedToolCalls;
    bucket.errorCount += stats.friction.errorCount;
  }
}

function finalizeAggregate(bucket: AggregateBucket) {
  const durations = [...bucket.durations].sort((a, b) => a - b);
  const p50 = durations.length > 0 ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.5))] : 0;
  const p95 = durations.length > 0 ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : 0;
  const avgDurationMs = durations.length > 0
    ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
    : 0;

  return {
    sessionCount: bucket.sessionCount,
    successCount: bucket.successCount,
    totalCostUsd: bucket.totalCostUsd,
    totalInputTokens: bucket.totalInputTokens,
    totalOutputTokens: bucket.totalOutputTokens,
    totalTurns: bucket.totalTurns,
    durationsMsP50: p50,
    durationsMsP95: p95,
    avgDurationMs,
    sessionsWithFriction: bucket.sessionsWithFriction,
    totalToolCalls: bucket.totalToolCalls,
    failedToolCalls: bucket.failedToolCalls,
    errorCount: bucket.errorCount,
  };
}

function toIsoStringOrNull(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toDateKey(value: string) {
  return toIsoStringOrNull(value)?.slice(0, 10) ?? value.slice(0, 10);
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
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

  const bySkill = new Map<string, SkillBucket>();
  const byModel = new Map<string, ModelBucket>();
  const byIssueType = new Map<string, IssueTypeBucket>();
  const byPriority = new Map<string, PriorityBucket>();
  const byProviderProfile = new Map<string, ProviderProfileBucket>();
  const timeSeries = new Map<string, TimeSeriesBucket>();
  const topExpensive: InsightsData["topExpensive"] = [];

  // Per-issue context-token leaderboard over a FIXED last-7-days window,
  // independent of the panel's range selector (the #751 feature is explicitly
  // "Top context consumers in the last 7 days"). When the selected range is
  // wider (30d/90d/all) we still only count sessions inside this window.
  const contextWindowFrom = startOfUtcDay(addUtcDays(now, -(RANGE_DAYS["7d"] - 1)));
  const contextByIssue = new Map<string, {
    issueId: string;
    issueNumber: number | null;
    issueTitle: string;
    sessionCount: number;
    contextTokens: number;
    totalCostUsd: number;
  }>();
  let contextWindowTotalTokens = 0;

  // Friction roll-up across the window (only from sessions with persisted friction).
  const frictionByTool = new Map<string, { calls: number; failed: number }>();
  const repeatedCommandAgg = new Map<string, { count: number; sessions: number }>();
  let frictionTotalToolCalls = 0;
  let frictionFailedToolCalls = 0;
  let frictionErrorTotal = 0;
  let sessionsWithFriction = 0;

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

  let totalCostUsd = 0;
  let totalTokens = 0;
  let sessionCount = 0;
  let successCount = 0;
  let earliestStartedAt: string | null = null;

  for (const row of rows) {
    const stats = parseStats(row.stats);
    const success = isSuccessful(stats, row.exitCode);
    const resolvedModel = stats?.model || row.wsModel || "Unknown";
    // Prefer the skill captured on the session at launch; fall back to the
    // workspace's current skill for historical sessions that predate per-session
    // attribution (graceful degradation).
    const resolvedSkillId = row.sessionSkillId ?? row.wsSkillId;
    const resolvedSkillName = row.sessionSkillName ?? row.skillName;
    const skillMapKey = resolvedSkillId ?? "__no_skill__";
    const skillName = resolvedSkillName ?? "No Skill";
    const startedAtIso = toIsoStringOrNull(row.startedAt) ?? dateTo;
    const dateKey = toDateKey(startedAtIso);
    const tokens = stats ? stats.inputTokens + stats.outputTokens : 0;

    sessionCount += 1;
    if (success) successCount += 1;
    if (!earliestStartedAt || startedAtIso < earliestStartedAt) {
      earliestStartedAt = startedAtIso;
    }

    if (stats?.friction) {
      sessionsWithFriction += 1;
      frictionTotalToolCalls += stats.friction.totalToolCalls;
      frictionFailedToolCalls += stats.friction.failedToolCalls;
      frictionErrorTotal += stats.friction.errorCount;
      for (const t of stats.friction.tools ?? []) {
        const e = frictionByTool.get(t.tool) ?? { calls: 0, failed: 0 };
        e.calls += t.count;
        e.failed += t.failedCount;
        frictionByTool.set(t.tool, e);
      }
      for (const rc of stats.friction.repeatedCommands ?? []) {
        const e = repeatedCommandAgg.get(rc.command) ?? { count: 0, sessions: 0 };
        e.count += rc.count;
        e.sessions += 1;
        repeatedCommandAgg.set(rc.command, e);
      }
    }

    const skillBucket = bySkill.get(skillMapKey) ?? {
      skillId: resolvedSkillId,
      skillName,
      ...createAggregateBucket(),
    };
    applyAggregate(skillBucket, stats, success);
    bySkill.set(skillMapKey, skillBucket);

    const modelBucket = byModel.get(resolvedModel) ?? {
      model: resolvedModel,
      ...createAggregateBucket(),
    };
    applyAggregate(modelBucket, stats, success);
    byModel.set(resolvedModel, modelBucket);

    const issueTypeBucket = byIssueType.get(row.issueType) ?? {
      issueType: row.issueType,
      sessionCount: 0,
      successCount: 0,
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };
    issueTypeBucket.sessionCount += 1;
    if (success) issueTypeBucket.successCount += 1;
    if (stats) {
      issueTypeBucket.totalCostUsd += stats.totalCostUsd;
      issueTypeBucket.totalInputTokens += stats.inputTokens;
      issueTypeBucket.totalOutputTokens += stats.outputTokens;
    }
    byIssueType.set(row.issueType, issueTypeBucket);

    const priorityBucket = byPriority.get(row.issuePriority) ?? {
      priority: row.issuePriority,
      sessionCount: 0,
      successCount: 0,
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };
    priorityBucket.sessionCount += 1;
    if (success) priorityBucket.successCount += 1;
    if (stats) {
      priorityBucket.totalCostUsd += stats.totalCostUsd;
      priorityBucket.totalInputTokens += stats.inputTokens;
      priorityBucket.totalOutputTokens += stats.outputTokens;
    }
    byPriority.set(row.issuePriority, priorityBucket);

    const provider = row.wsProvider ?? "unknown";
    const profile = row.wsClaudeProfile ?? "";
    const ppKey = `${provider}::${profile}`;
    const ppBucket = byProviderProfile.get(ppKey) ?? {
      provider,
      profile,
      activeWorkspaceIds: new Set<string>(),
      ...createAggregateBucket(),
    };
    applyAggregate(ppBucket, stats, success);
    byProviderProfile.set(ppKey, ppBucket);

    const timeSeriesBucket = timeSeries.get(dateKey) ?? {
      date: dateKey,
      sessionCount: 0,
      successCount: 0,
      totalCostUsd: 0,
    };
    timeSeriesBucket.sessionCount += 1;
    if (success) timeSeriesBucket.successCount += 1;
    if (stats) timeSeriesBucket.totalCostUsd += stats.totalCostUsd;
    timeSeries.set(dateKey, timeSeriesBucket);

    if (stats) {
      totalCostUsd += stats.totalCostUsd;
      totalTokens += tokens;
      topExpensive.push({
        sessionId: row.sessionId,
        workspaceId: row.workspaceId,
        issueId: row.issueId,
        issueNumber: row.issueNumber,
        issueTitle: row.issueTitle,
        skillName: row.skillName,
        model: resolvedModel || null,
        totalCostUsd: stats.totalCostUsd,
        totalTokens: tokens,
        numTurns: stats.numTurns,
        durationMs: stats.durationMs,
        success,
        startedAt: startedAtIso,
      });
    }

    // Context-consumer leaderboard: only sessions within the fixed 7-day window.
    if (startedAtIso >= contextWindowFrom.toISOString()) {
      const sessionContextTokens = contextTokensFor(stats);
      contextWindowTotalTokens += sessionContextTokens;
      const existing = contextByIssue.get(row.issueId);
      if (existing) {
        existing.sessionCount += 1;
        existing.contextTokens += sessionContextTokens;
        existing.totalCostUsd += stats?.totalCostUsd ?? 0;
      } else {
        contextByIssue.set(row.issueId, {
          issueId: row.issueId,
          issueNumber: row.issueNumber,
          issueTitle: row.issueTitle,
          sessionCount: 1,
          contextTokens: sessionContextTokens,
          totalCostUsd: stats?.totalCostUsd ?? 0,
        });
      }
    }
  }

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
