export type ProviderFilter = "all" | string;

export type InsightsRange = "7d" | "30d" | "90d" | "all";
export type SortDirection = "asc" | "desc";
export type MetricSortKey = "label" | "sessionCount" | "successRate" | "avgCost" | "totalCostUsd" | "avgTokens" | "avgTurns" | "durationsMsP50" | "durationsMsP95";

export interface MetricRowBase {
  sessionCount: number;
  successCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTurns: number;
  durationsMsP50: number;
  durationsMsP95: number;
  avgDurationMs: number;
}

export interface InsightsData {
  bySkill: Array<MetricRowBase & {
    skillId: string | null;
    skillName: string;
  }>;
  byModel: Array<MetricRowBase & {
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
  byProviderProfile: Array<{
    provider: string;
    profile: string;
    sessionCount: number;
    successCount: number;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTurns: number;
    durationsMsP50: number;
    durationsMsP95: number;
    avgDurationMs: number;
    activeWorkspaceCount: number;
  }>;
  topContextConsumers: {
    windowFrom: string;
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
  totals: {
    sessionCount: number;
    successCount: number;
    totalCostUsd: number;
    totalTokens: number;
    dateFrom: string;
    dateTo: string;
  };
}

export interface QuotaMetric {
  label: string;
  percent: number | null;
  detail: string | null;
  resetInSeconds: number | null;
  expectedPercent?: number;
  pace?: number;
  projectedAtReset?: number;
}

export interface QuotaProviderEntry {
  id: string;
  label: string;
  accent: string;
  loginUrl: string;
  hasCreds: boolean;
  status: "ok" | "auth" | "error";
  plan?: string;
  metrics?: QuotaMetric[];
  error?: string;
}

export interface QuotaUsageResult {
  providers: QuotaProviderEntry[];
  scrapedAt: string;
}

export interface InsightsPanelProps {
  projectId: string | null;
  onSessionClick: (sessionId: string, workspaceId: string, issueId: string) => void;
}

export interface SortState {
  key: MetricSortKey;
  direction: SortDirection;
}

export const RANGE_OPTIONS: Array<{ value: InsightsRange; label: string }> = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
];

export function formatCurrency(value: number) {
  return `$${value.toFixed(4)}`;
}

export function formatSuccessRate(successCount: number, sessionCount: number) {
  if (sessionCount === 0) return "0%";
  return `${((successCount / sessionCount) * 100).toFixed(1)}%`;
}

export function formatTokens(value: number) {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 1)}M`;
  }
  if (absolute >= 1_000) {
    return `${(value / 1_000).toFixed(absolute >= 100_000 ? 0 : 1)}K`;
  }
  return Math.round(value).toLocaleString("en-US");
}

export function formatDuration(value: number) {
  const totalSeconds = Math.max(0, Math.round(value / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function formatCompactDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatStartedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function formatClockTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function formatCountdown(seconds: number | null) {
  if (seconds == null || seconds <= 0) return "now";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

export function getAvgCost(row: MetricRowBase) {
  return row.sessionCount > 0 ? row.totalCostUsd / row.sessionCount : 0;
}

export function getAvgTokens(row: MetricRowBase) {
  return row.sessionCount > 0 ? (row.totalInputTokens + row.totalOutputTokens) / row.sessionCount : 0;
}

export function getAvgTurns(row: MetricRowBase) {
  return row.sessionCount > 0 ? row.totalTurns / row.sessionCount : 0;
}

export function getMetricSortValue<T extends MetricRowBase>(row: T, label: string, key: MetricSortKey) {
  switch (key) {
    case "label":
      return label.toLowerCase();
    case "sessionCount":
      return row.sessionCount;
    case "successRate":
      return row.sessionCount > 0 ? row.successCount / row.sessionCount : 0;
    case "avgCost":
      return getAvgCost(row);
    case "totalCostUsd":
      return row.totalCostUsd;
    case "avgTokens":
      return getAvgTokens(row);
    case "avgTurns":
      return getAvgTurns(row);
    case "durationsMsP50":
      return row.durationsMsP50;
    case "durationsMsP95":
      return row.durationsMsP95;
    default:
      return 0;
  }
}

export function sortMetricRows<T extends MetricRowBase>(rows: T[], sort: SortState, getLabel: (row: T) => string) {
  return [...rows].sort((left, right) => {
    const leftValue = getMetricSortValue(left, getLabel(left), sort.key);
    const rightValue = getMetricSortValue(right, getLabel(right), sort.key);

    if (typeof leftValue === "string" && typeof rightValue === "string") {
      const result = leftValue.localeCompare(rightValue);
      return sort.direction === "asc" ? result : -result;
    }

    const result = Number(leftValue) - Number(rightValue);
    if (result !== 0) {
      return sort.direction === "asc" ? result : -result;
    }

    return getLabel(left).localeCompare(getLabel(right));
  });
}

export function utcDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addUtcDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function buildSparklineSeries(timeSeries: InsightsData["timeSeries"], range: InsightsRange) {
  if (range !== "7d") return timeSeries;

  const today = startOfUtcDay(new Date());
  const start = addUtcDays(today, -13);
  const byDate = new Map(timeSeries.map((point) => [point.date, point]));
  const padded: InsightsData["timeSeries"] = [];

  for (let cursor = new Date(start); cursor <= today; cursor = addUtcDays(cursor, 1)) {
    const key = utcDateKey(cursor);
    padded.push(byDate.get(key) ?? {
      date: key,
      sessionCount: 0,
      successCount: 0,
      totalCostUsd: 0,
    });
  }

  return padded;
}
