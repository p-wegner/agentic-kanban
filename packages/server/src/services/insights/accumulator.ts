/**
 * The single-pass session-row aggregation for the Insights panel, split out of
 * `insights.service.ts` (#831 — #728/#819's split-responsibility remainder).
 *
 * Consumer evidence for the seam: `insights-accumulator.test.ts` already exercises only
 * this half (no database — it builds rows by hand and folds them through
 * `accumulateInsightsRow`), while `routes/insights.ts` imports only `computeInsights`/
 * `parseRange` from the facade and never reaches into the accumulator internals. The two
 * consumer sets are disjoint, which is what `types.ts`'s `InsightsAccumulator` doc
 * already claimed ("split out so the aggregation is unit-testable without a database") —
 * this split makes that claim physically true.
 *
 * Pure module: no database import, no `Database` type. `computeInsights` (still in
 * `insights.service.ts`) is the only thing that seeds an accumulator, queries rows, and
 * finalizes the buckets into the route-facing `InsightsData` shape.
 *
 * The shared bucket types + primitives live in `types.ts`, and the eight per-dimension
 * fold functions (`accumulateFriction`, `accumulateSkillBucket`, …) live in
 * `dimension-folds.ts` — extracting this file from `insights.service.ts` in one piece
 * would have landed 21 top-level function/class declarations here, one over the
 * god-module gate's flat 20-declaration ceiling (#889), so the split went three ways
 * instead of two. The dimension folds are independent, single-caller
 * (`accumulateInsightsRow` below) writers with no fan-in among themselves — a materially
 * different responsibility from this file's remaining job of parsing/normalizing a row
 * and driving the fold sequence once per row.
 */
import {
  parseStats,
  isSuccessful,
  toIsoStringOrNull,
  toDateKey,
  type AccumulateContext,
  type InsightsAccumulator,
  type InsightsSessionRow,
  type NormalizedSessionStats,
} from "./types.js";
import {
  accumulateFriction,
  accumulateSkillBucket,
  accumulateModelBucket,
  accumulateCategoryBucket,
  accumulateProviderProfileBucket,
  accumulateTimeSeriesBucket,
  accumulateExpensive,
  accumulateContextLeaderboard,
} from "./dimension-folds.js";

export * from "./types.js";

/** Per-row facts derived from a session row, independent of the accumulator. */
interface SessionRowFacts {
  stats: NormalizedSessionStats | null;
  success: boolean;
  resolvedModel: string;
  resolvedSkillId: string | null;
  skillMapKey: string;
  skillName: string;
  startedAtIso: string;
  dateKey: string;
  tokens: number;
}

/** Resolve the model/skill/timing fields a row contributes (graceful fallbacks). */
function deriveSessionRowFacts(row: InsightsSessionRow, ctx: AccumulateContext): SessionRowFacts {
  const stats = parseStats(row.stats);
  // Prefer the skill captured on the session at launch; fall back to the
  // workspace's current skill for historical sessions that predate per-session
  // attribution (graceful degradation).
  const resolvedSkillId = row.sessionSkillId ?? row.wsSkillId;
  const startedAtIso = toIsoStringOrNull(row.startedAt) ?? ctx.fallbackStartedAtIso;
  return {
    stats,
    success: isSuccessful(stats, row.exitCode),
    resolvedModel: stats?.model || row.wsModel || "Unknown",
    resolvedSkillId,
    skillMapKey: resolvedSkillId ?? "__no_skill__",
    skillName: row.sessionSkillName ?? row.skillName ?? "No Skill",
    startedAtIso,
    dateKey: toDateKey(startedAtIso),
    tokens: stats ? stats.inputTokens + stats.outputTokens : 0,
  };
}

/** Fold one session row into the accumulator. Pure (mutates only `acc`). */
export function accumulateInsightsRow(acc: InsightsAccumulator, row: InsightsSessionRow, ctx: AccumulateContext): void {
  const f = deriveSessionRowFacts(row, ctx);

  acc.sessionCount += 1;
  if (f.success) acc.successCount += 1;
  if (!acc.earliestStartedAt || f.startedAtIso < acc.earliestStartedAt) {
    acc.earliestStartedAt = f.startedAtIso;
  }

  accumulateFriction(acc, f.stats);
  accumulateSkillBucket(acc.bySkill, f.skillMapKey, f.resolvedSkillId, f.skillName, f.stats, f.success);
  accumulateModelBucket(acc.byModel, f.resolvedModel, f.stats, f.success);
  accumulateCategoryBucket(
    acc.byIssueType,
    row.issueType,
    () => ({
      issueType: row.issueType,
      sessionCount: 0,
      successCount: 0,
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    }),
    f.stats,
    f.success,
  );
  accumulateCategoryBucket(
    acc.byPriority,
    row.issuePriority,
    () => ({
      priority: row.issuePriority,
      sessionCount: 0,
      successCount: 0,
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    }),
    f.stats,
    f.success,
  );
  accumulateProviderProfileBucket(
    acc.byProviderProfile,
    row.wsProvider ?? "unknown",
    row.wsClaudeProfile ?? "",
    f.stats,
    f.success,
  );
  accumulateTimeSeriesBucket(acc.timeSeries, f.dateKey, f.stats, f.success);
  if (f.stats) accumulateExpensive(acc, row, f.stats, f.resolvedModel, f.tokens, f.success, f.startedAtIso);
  accumulateContextLeaderboard(acc, row, f.stats, f.startedAtIso, ctx.contextWindowFromIso);
}
