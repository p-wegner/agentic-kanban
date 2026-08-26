/**
 * Per-dimension folds for the Insights accumulator, split out of `accumulator.ts` when
 * that file itself tripped the god-module gate post-split (#831 — the extraction that
 * fixed #728/#819's split-responsibility remainder for `insights.service.ts` produced a
 * new 21-function file, over the 20-declaration cohesion ceiling).
 *
 * Each function here folds one session into a SINGLE accumulator dimension (skill,
 * model, issue-type/priority, provider/profile, time-series, top-expensive, context
 * leaderboard, friction). They are pure (mutate only the passed-in map/accumulator) and
 * individually trivial — the seam is real, not cosmetic: `accumulateInsightsRow` in
 * `accumulator.ts` is the only caller, calling each fold exactly once per row, so this
 * module is a flat list of independent dimension-writers with no fan-in among
 * themselves. That is a materially different responsibility from `accumulator.ts`'s
 * remaining job (parse/normalize a row, derive its facts, drive the fold sequence).
 */
import type {
  InsightsAccumulator,
  InsightsSessionRow,
  NormalizedSessionStats,
  ProviderProfileBucket,
  SkillBucket,
  ModelBucket,
  TimeSeriesBucket,
} from "./types.js";
import { applyAggregate, contextTokensFor, createAggregateBucket } from "./types.js";

export function accumulateFriction(acc: InsightsAccumulator, stats: NormalizedSessionStats | null): void {
  if (!stats?.friction) return;
  acc.sessionsWithFriction += 1;
  acc.frictionTotalToolCalls += stats.friction.totalToolCalls;
  acc.frictionFailedToolCalls += stats.friction.failedToolCalls;
  acc.frictionErrorTotal += stats.friction.errorCount;
  for (const t of stats.friction.tools ?? []) {
    const e = acc.frictionByTool.get(t.tool) ?? { calls: 0, failed: 0 };
    e.calls += t.count;
    e.failed += t.failedCount;
    acc.frictionByTool.set(t.tool, e);
  }
  for (const rc of stats.friction.repeatedCommands ?? []) {
    const e = acc.repeatedCommandAgg.get(rc.command) ?? { count: 0, sessions: 0 };
    e.count += rc.count;
    e.sessions += 1;
    acc.repeatedCommandAgg.set(rc.command, e);
  }
}

export function accumulateSkillBucket(
  bySkill: Map<string, SkillBucket>,
  key: string,
  skillId: string | null,
  skillName: string,
  stats: NormalizedSessionStats | null,
  success: boolean,
): void {
  const bucket = bySkill.get(key) ?? { skillId, skillName, ...createAggregateBucket() };
  applyAggregate(bucket, stats, success);
  bySkill.set(key, bucket);
}

export function accumulateModelBucket(
  byModel: Map<string, ModelBucket>,
  model: string,
  stats: NormalizedSessionStats | null,
  success: boolean,
): void {
  const bucket = byModel.get(model) ?? { model, ...createAggregateBucket() };
  applyAggregate(bucket, stats, success);
  byModel.set(model, bucket);
}

// IssueTypeBucket and PriorityBucket are structurally identical (one discriminator
// field plus the same five session/cost/token counters), so both fold through one
// generic helper instead of two byte-identical 15-line blocks.
export function accumulateCategoryBucket<
  T extends {
    sessionCount: number;
    successCount: number;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  },
>(
  map: Map<string, T>,
  key: string,
  create: () => T,
  stats: NormalizedSessionStats | null,
  success: boolean,
): void {
  const bucket = map.get(key) ?? create();
  bucket.sessionCount += 1;
  if (success) bucket.successCount += 1;
  if (stats) {
    bucket.totalCostUsd += stats.totalCostUsd;
    bucket.totalInputTokens += stats.inputTokens;
    bucket.totalOutputTokens += stats.outputTokens;
  }
  map.set(key, bucket);
}

export function accumulateProviderProfileBucket(
  byProviderProfile: Map<string, ProviderProfileBucket>,
  provider: string,
  profile: string,
  stats: NormalizedSessionStats | null,
  success: boolean,
): void {
  const key = `${provider}::${profile}`;
  const bucket = byProviderProfile.get(key) ?? {
    provider,
    profile,
    activeWorkspaceIds: new Set<string>(),
    ...createAggregateBucket(),
  };
  applyAggregate(bucket, stats, success);
  byProviderProfile.set(key, bucket);
}

export function accumulateTimeSeriesBucket(
  timeSeries: Map<string, TimeSeriesBucket>,
  dateKey: string,
  stats: NormalizedSessionStats | null,
  success: boolean,
): void {
  const bucket = timeSeries.get(dateKey) ?? {
    date: dateKey,
    sessionCount: 0,
    successCount: 0,
    totalCostUsd: 0,
  };
  bucket.sessionCount += 1;
  if (success) bucket.successCount += 1;
  if (stats) bucket.totalCostUsd += stats.totalCostUsd;
  timeSeries.set(dateKey, bucket);
}

export function accumulateExpensive(
  acc: InsightsAccumulator,
  row: InsightsSessionRow,
  stats: NormalizedSessionStats,
  resolvedModel: string,
  tokens: number,
  success: boolean,
  startedAtIso: string,
): void {
  acc.totalCostUsd += stats.totalCostUsd;
  acc.totalTokens += tokens;
  acc.topExpensive.push({
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

export function accumulateContextLeaderboard(
  acc: InsightsAccumulator,
  row: InsightsSessionRow,
  stats: NormalizedSessionStats | null,
  startedAtIso: string,
  contextWindowFromIso: string,
): void {
  // Context-consumer leaderboard: only sessions within the fixed 7-day window.
  if (startedAtIso < contextWindowFromIso) return;
  const sessionContextTokens = contextTokensFor(stats);
  acc.contextWindowTotalTokens += sessionContextTokens;
  const existing = acc.contextByIssue.get(row.issueId);
  if (existing) {
    existing.sessionCount += 1;
    existing.contextTokens += sessionContextTokens;
    existing.totalCostUsd += stats?.totalCostUsd ?? 0;
  } else {
    acc.contextByIssue.set(row.issueId, {
      issueId: row.issueId,
      issueNumber: row.issueNumber,
      issueTitle: row.issueTitle,
      sessionCount: 1,
      contextTokens: sessionContextTokens,
      totalCostUsd: stats?.totalCostUsd ?? 0,
    });
  }
}
