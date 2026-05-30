import { and, eq, gte } from "drizzle-orm";
import { agentSkills, issues, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";

const RANGE_DAYS = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
} as const;

type InsightsRange = keyof typeof RANGE_DAYS | "all";

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
}

interface AggregateBucket {
  sessionCount: number;
  successCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTurns: number;
  durations: number[];
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

interface TimeSeriesBucket {
  date: string;
  sessionCount: number;
  successCount: number;
  totalCostUsd: number;
}

interface InsightsData {
  bySkill: Array<{
    skillId: string | null;
    skillName: string;
    sessionCount: number;
    successCount: number;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTurns: number;
    durationsMsP50: number;
    durationsMsP95: number;
    avgDurationMs: number;
  }>;
  byModel: Array<{
    model: string;
    sessionCount: number;
    successCount: number;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTurns: number;
    durationsMsP50: number;
    durationsMsP95: number;
    avgDurationMs: number;
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
  totals: {
    sessionCount: number;
    successCount: number;
    totalCostUsd: number;
    totalTokens: number;
    dateFrom: string;
    dateTo: string;
  };
}

function parseRange(value: string | undefined): InsightsRange {
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
    };
  } catch {
    return null;
  }
}

function isSuccessful(stats: ParsedSessionStats | null, exitCode: string | null) {
  return !!stats && (stats.success === true || exitCode === "0");
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

export function createInsightsRoute(database: Database = db) {
  const router = createRouter();

  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId query parameter required" }, 400);

    const range = parseRange(c.req.query("range"));
    const now = new Date();
    const dateTo = now.toISOString();
    const queryDateFrom = range === "all"
      ? null
      : startOfUtcDay(addUtcDays(now, -(RANGE_DAYS[range] - 1)));

    const whereClause = queryDateFrom
      ? and(
          eq(issues.projectId, projectId),
          gte(sessions.startedAt, queryDateFrom.toISOString()),
        )
      : eq(issues.projectId, projectId);

    const rows = await database
      .select({
        sessionId: sessions.id,
        workspaceId: sessions.workspaceId,
        stats: sessions.stats,
        startedAt: sessions.startedAt,
        exitCode: sessions.exitCode,
        wsModel: workspaces.model,
        wsSkillId: workspaces.skillId,
        sessionSkillId: sessions.skillId,
        sessionSkillName: sessions.skillName,
        issueType: issues.issueType,
        issuePriority: issues.priority,
        issueTitle: issues.title,
        issueNumber: issues.issueNumber,
        issueId: issues.id,
        skillName: agentSkills.name,
      })
      .from(sessions)
      .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .leftJoin(agentSkills, eq(workspaces.skillId, agentSkills.id))
      .where(whereClause);

    const bySkill = new Map<string, SkillBucket>();
    const byModel = new Map<string, ModelBucket>();
    const byIssueType = new Map<string, IssueTypeBucket>();
    const byPriority = new Map<string, PriorityBucket>();
    const timeSeries = new Map<string, TimeSeriesBucket>();
    const topExpensive: InsightsData["topExpensive"] = [];

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

    const response: InsightsData = {
      bySkill: [...bySkill.values()]
        .map((bucket) => ({
          skillId: bucket.skillId,
          skillName: bucket.skillName,
          ...finalizeAggregate(bucket),
        }))
        .sort((a, b) => b.totalCostUsd - a.totalCostUsd || b.sessionCount - a.sessionCount || a.skillName.localeCompare(b.skillName)),
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
      timeSeries: filledTimeSeries,
      topExpensive: topExpensive
        .sort((a, b) => b.totalCostUsd - a.totalCostUsd || b.totalTokens - a.totalTokens || a.startedAt.localeCompare(b.startedAt))
        .slice(0, 10),
      totals: {
        sessionCount,
        successCount,
        totalCostUsd,
        totalTokens,
        dateFrom: effectiveDateFrom,
        dateTo,
      },
    };

    return c.json(response);
  });

  return router;
}
