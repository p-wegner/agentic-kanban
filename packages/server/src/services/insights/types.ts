/**
 * Shared bucket types and pure aggregate primitives for the Insights accumulator split
 * (#831). Both `accumulator.ts` (row parsing/orchestration) and `dimension-folds.ts`
 * (the eight per-dimension fold functions) depend on these — living here instead of in
 * either sibling avoids a two-file import cycle between them.
 */
import type { SessionFrictionStats } from "@agentic-kanban/shared";
import { parseSessionStatsBlob } from "@agentic-kanban/shared";
import type { getInsightsSessionRows } from "../../repositories/session.repository.js";

export interface NormalizedSessionStats {
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

export interface AggregateBucket {
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

export interface SkillBucket extends AggregateBucket {
  skillId: string | null;
  skillName: string;
}

export interface ModelBucket extends AggregateBucket {
  model: string;
}

export interface IssueTypeBucket {
  issueType: string;
  sessionCount: number;
  successCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface PriorityBucket {
  priority: string;
  sessionCount: number;
  successCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface ProviderProfileBucket extends AggregateBucket {
  provider: string;
  profile: string;
  activeWorkspaceIds: Set<string>;
}

export interface TimeSeriesBucket {
  date: string;
  sessionCount: number;
  successCount: number;
  totalCostUsd: number;
}

export interface FinalizedAggregateFields {
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

export type InsightsSessionRow = Awaited<ReturnType<typeof getInsightsSessionRows>>[number];

export interface ContextIssueAgg {
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  sessionCount: number;
  contextTokens: number;
  totalCostUsd: number;
}

export interface InsightsTopExpensiveRow {
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
}

/** Window-dependent inputs the per-row aggregation needs from computeInsights. */
export interface AccumulateContext {
  /** ISO fallback for a session with no startedAt (the panel window's end). */
  fallbackStartedAtIso: string;
  /** Start of the fixed 7-day context-consumer leaderboard window, ISO. */
  contextWindowFromIso: string;
}

/**
 * Mutable accumulator for the single-pass session aggregation. computeInsights
 * seeds one, folds every row through `accumulateInsightsRow`, then reads the
 * buckets/counters out for finalization. Split out so the (historically dense)
 * aggregation is unit-testable without a database.
 */
export interface InsightsAccumulator {
  bySkill: Map<string, SkillBucket>;
  byModel: Map<string, ModelBucket>;
  byIssueType: Map<string, IssueTypeBucket>;
  byPriority: Map<string, PriorityBucket>;
  byProviderProfile: Map<string, ProviderProfileBucket>;
  timeSeries: Map<string, TimeSeriesBucket>;
  topExpensive: InsightsTopExpensiveRow[];
  contextByIssue: Map<string, ContextIssueAgg>;
  frictionByTool: Map<string, { calls: number; failed: number }>;
  repeatedCommandAgg: Map<string, { count: number; sessions: number }>;
  totalCostUsd: number;
  totalTokens: number;
  sessionCount: number;
  successCount: number;
  earliestStartedAt: string | null;
  contextWindowTotalTokens: number;
  frictionTotalToolCalls: number;
  frictionFailedToolCalls: number;
  frictionErrorTotal: number;
  sessionsWithFriction: number;
}

/**
 * Context tokens for a session = the tokens that occupy the model's context
 * window. Mirrors the `contextTokens || inputTokens + cacheReadTokens`
 * convention used in workspace-summary / session-stats / workspace.repository.
 */
export function contextTokensFor(stats: NormalizedSessionStats | null): number {
  if (!stats) return 0;
  const explicit = stats.contextTokens ?? 0;
  return explicit || (stats.inputTokens + (stats.cacheReadTokens ?? 0));
}

export function createAggregateBucket(): AggregateBucket {
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

export function applyAggregate(bucket: AggregateBucket, stats: NormalizedSessionStats | null, success: boolean) {
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

export function finalizeAggregate(bucket: AggregateBucket): FinalizedAggregateFields {
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

export function createInsightsAccumulator(): InsightsAccumulator {
  return {
    bySkill: new Map(),
    byModel: new Map(),
    byIssueType: new Map(),
    byPriority: new Map(),
    byProviderProfile: new Map(),
    timeSeries: new Map(),
    topExpensive: [],
    contextByIssue: new Map(),
    frictionByTool: new Map(),
    repeatedCommandAgg: new Map(),
    totalCostUsd: 0,
    totalTokens: 0,
    sessionCount: 0,
    successCount: 0,
    earliestStartedAt: null,
    contextWindowTotalTokens: 0,
    frictionTotalToolCalls: 0,
    frictionFailedToolCalls: 0,
    frictionErrorTotal: 0,
    sessionsWithFriction: 0,
  };
}

/**
 * #571: this is NOT a fifth copy of the stats blob — it is the NORMALIZED projection, with
 * every numeric defaulted and every field required, which is what lets the aggregation
 * below add them without a `?? 0` at each use. Only the raw PARSE is shared
 * (`parseSessionStatsBlob`); the shape stays local because making it optional like the
 * blob would push those defaults out into ~10 call sites.
 */
export function parseStats(raw: string | null): NormalizedSessionStats | null {
  const parsed = parseSessionStatsBlob(raw);
  if (!parsed) return null;
  {
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
      friction: parsed.friction && typeof parsed.friction === "object" ? parsed.friction as SessionFrictionStats : undefined,
    };
  }
}

export function isSuccessful(stats: NormalizedSessionStats | null, exitCode: string | null) {
  return !!stats && (stats.success === true || exitCode === "0");
}

export function toIsoStringOrNull(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function toDateKey(value: string) {
  return toIsoStringOrNull(value)?.slice(0, 10) ?? value.slice(0, 10);
}

export function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addUtcDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}
