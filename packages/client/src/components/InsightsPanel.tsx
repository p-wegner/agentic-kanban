import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { PRIMARY_SERIES } from "../lib/chartColors";

type InsightsRange = "7d" | "30d" | "90d" | "all";
type SortDirection = "asc" | "desc";
type MetricSortKey = "label" | "sessionCount" | "successRate" | "avgCost" | "totalCostUsd" | "avgTokens" | "avgTurns" | "durationsMsP50" | "durationsMsP95";

interface MetricRowBase {
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

interface InsightsData {
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
  totals: {
    sessionCount: number;
    successCount: number;
    totalCostUsd: number;
    totalTokens: number;
    dateFrom: string;
    dateTo: string;
  };
}

interface InsightsPanelProps {
  projectId: string | null;
  onSessionClick: (sessionId: string, workspaceId: string, issueId: string) => void;
}

interface SortState {
  key: MetricSortKey;
  direction: SortDirection;
}

const RANGE_OPTIONS: Array<{ value: InsightsRange; label: string }> = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
];

function formatCurrency(value: number) {
  return `$${value.toFixed(4)}`;
}

function formatSuccessRate(successCount: number, sessionCount: number) {
  if (sessionCount === 0) return "0%";
  return `${((successCount / sessionCount) * 100).toFixed(1)}%`;
}

function formatTokens(value: number) {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 1)}M`;
  }
  if (absolute >= 1_000) {
    return `${(value / 1_000).toFixed(absolute >= 100_000 ? 0 : 1)}K`;
  }
  return Math.round(value).toLocaleString("en-US");
}

function formatDuration(value: number) {
  const totalSeconds = Math.max(0, Math.round(value / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatCompactDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatStartedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function getAvgCost(row: MetricRowBase) {
  return row.sessionCount > 0 ? row.totalCostUsd / row.sessionCount : 0;
}

function getAvgTokens(row: MetricRowBase) {
  return row.sessionCount > 0 ? (row.totalInputTokens + row.totalOutputTokens) / row.sessionCount : 0;
}

function getAvgTurns(row: MetricRowBase) {
  return row.sessionCount > 0 ? row.totalTurns / row.sessionCount : 0;
}

function getMetricSortValue<T extends MetricRowBase>(row: T, label: string, key: MetricSortKey) {
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

function sortMetricRows<T extends MetricRowBase>(rows: T[], sort: SortState, getLabel: (row: T) => string) {
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

function utcDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function buildSparklineSeries(timeSeries: InsightsData["timeSeries"], range: InsightsRange) {
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

function SummaryCard({ label, value, subtext }: { label: string; value: string; subtext?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-gray-900 dark:text-gray-100">{value}</div>
      {subtext && <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{subtext}</div>}
    </div>
  );
}

function SortableMetricTable<T extends MetricRowBase>({
  title,
  rows,
  sort,
  onSortChange,
  getLabel,
  emptyLabel,
}: {
  title: string;
  rows: T[];
  sort: SortState;
  onSortChange: (key: MetricSortKey) => void;
  getLabel: (row: T) => string;
  emptyLabel: string;
}) {
  const headers: Array<{ key: MetricSortKey; label: string; className?: string }> = [
    { key: "label", label: title === "By Skill" ? "Skill" : "Model", className: "text-left" },
    { key: "sessionCount", label: "Sessions" },
    { key: "successRate", label: "Success Rate" },
    { key: "avgCost", label: "Avg Cost" },
    { key: "totalCostUsd", label: "Total Cost" },
    { key: "avgTokens", label: "Avg Tokens" },
    { key: "avgTurns", label: "Avg Turns" },
    { key: "durationsMsP50", label: "P50 Duration" },
    { key: "durationsMsP95", label: "P95 Duration" },
  ];

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm overflow-hidden">
      <div className="border-b border-gray-200 dark:border-gray-800 px-4 py-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-950/60 text-gray-600 dark:text-gray-400">
            <tr>
              {headers.map((header) => {
                const active = sort.key === header.key;
                return (
                  <th key={header.key} className={`px-4 py-3 font-medium whitespace-nowrap ${header.className ?? "text-right"}`}>
                    <button
                      type="button"
                      onClick={() => onSortChange(header.key)}
                      className={`inline-flex items-center gap-1 ${header.className === "text-left" ? "justify-start" : "justify-end w-full"} hover:text-gray-900 dark:hover:text-gray-100 transition-colors`}
                    >
                      <span>{header.label}</span>
                      <span className={`text-[10px] ${active ? "text-brand-500" : "text-gray-300 dark:text-gray-600"}`}>
                        {active ? (sort.direction === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">{emptyLabel}</td>
              </tr>
            ) : rows.map((row) => {
              const label = getLabel(row);
              return (
                <tr key={label} className="border-t border-gray-100 dark:border-gray-800/80 text-gray-700 dark:text-gray-300">
                  <td className="px-4 py-3 font-medium text-left text-gray-900 dark:text-gray-100">{label}</td>
                  <td className="px-4 py-3 text-right">{row.sessionCount}</td>
                  <td className="px-4 py-3 text-right">{formatSuccessRate(row.successCount, row.sessionCount)}</td>
                  <td className="px-4 py-3 text-right">{formatCurrency(getAvgCost(row))}</td>
                  <td className="px-4 py-3 text-right">{formatCurrency(row.totalCostUsd)}</td>
                  <td className="px-4 py-3 text-right">{formatTokens(getAvgTokens(row))}</td>
                  <td className="px-4 py-3 text-right">{getAvgTurns(row).toFixed(1)}</td>
                  <td className="px-4 py-3 text-right">{formatDuration(row.durationsMsP50)}</td>
                  <td className="px-4 py-3 text-right">{formatDuration(row.durationsMsP95)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MiniBreakdownTable({
  title,
  rows,
  labelKey,
}: {
  title: string;
  rows: Array<{
    issueType?: string;
    priority?: string;
    sessionCount: number;
    successCount: number;
    totalCostUsd: number;
  }>;
  labelKey: "issueType" | "priority";
}) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm overflow-hidden">
      <div className="border-b border-gray-200 dark:border-gray-800 px-4 py-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-950/60 text-gray-600 dark:text-gray-400">
            <tr>
              <th className="px-4 py-3 text-left font-medium whitespace-nowrap">{labelKey === "issueType" ? "Type" : "Priority"}</th>
              <th className="px-4 py-3 text-right font-medium whitespace-nowrap">Sessions</th>
              <th className="px-4 py-3 text-right font-medium whitespace-nowrap">Success%</th>
              <th className="px-4 py-3 text-right font-medium whitespace-nowrap">Avg Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">No session data in this range.</td>
              </tr>
            ) : rows.map((row) => {
              const label = row[labelKey] ?? "Unknown";
              const avgCost = row.sessionCount > 0 ? row.totalCostUsd / row.sessionCount : 0;
              return (
                <tr key={label} className="border-t border-gray-100 dark:border-gray-800/80 text-gray-700 dark:text-gray-300">
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 capitalize">{label}</td>
                  <td className="px-4 py-3 text-right">{row.sessionCount}</td>
                  <td className="px-4 py-3 text-right">{formatSuccessRate(row.successCount, row.sessionCount)}</td>
                  <td className="px-4 py-3 text-right">{formatCurrency(avgCost)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CostSparkline({ series }: { series: InsightsData["timeSeries"] }) {
  const width = 640;
  const height = 180;
  const padding = 20;
  const maxCost = Math.max(...series.map((point) => point.totalCostUsd), 0);
  const safeSeries = series.length > 0 ? series : [{ date: utcDateKey(new Date()), sessionCount: 0, successCount: 0, totalCostUsd: 0 }];

  const points = safeSeries.map((point, index) => {
    const x = safeSeries.length === 1
      ? width / 2
      : (index / (safeSeries.length - 1)) * (width - padding * 2) + padding;
    const y = maxCost === 0
      ? height - padding
      : height - padding - (point.totalCostUsd / maxCost) * (height - padding * 2);
    return { x, y, point };
  });

  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ");
  const areaPath = `${linePath} L${points[points.length - 1].x} ${height - padding} L${points[0].x} ${height - padding} Z`;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Daily Cost Trend</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">{safeSeries.length} day window</p>
        </div>
        <div className="text-right text-xs text-gray-500 dark:text-gray-400">
          <div>Peak {formatCurrency(maxCost)}</div>
          <div>{formatCompactDate(safeSeries[0].date)} → {formatCompactDate(safeSeries[safeSeries.length - 1].date)}</div>
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-44">
        <path d={areaPath} fill="rgba(194, 95, 54, 0.16)" />
        <path d={linePath} fill="none" stroke={PRIMARY_SERIES} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {points.map(({ x, y, point }) => (
          <circle key={point.date} cx={x} cy={y} r="2.5" fill={PRIMARY_SERIES}>
            <title>{`${point.date}: ${formatCurrency(point.totalCostUsd)} (${point.sessionCount} sessions)`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

export function InsightsPanel({ projectId, onSessionClick }: InsightsPanelProps) {
  const [range, setRange] = useState<InsightsRange>("30d");
  const [data, setData] = useState<InsightsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skillSort, setSkillSort] = useState<SortState>({ key: "totalCostUsd", direction: "desc" });
  const [modelSort, setModelSort] = useState<SortState>({ key: "totalCostUsd", direction: "desc" });

  useEffect(() => {
    if (!projectId) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    apiFetch<InsightsData>(`/api/insights?projectId=${encodeURIComponent(projectId)}&range=${range}`)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load insights");
          setData(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, range]);

  const sortedSkills = useMemo(
    () => sortMetricRows(data?.bySkill ?? [], skillSort, (row) => row.skillName),
    [data?.bySkill, skillSort],
  );
  const sortedModels = useMemo(
    () => sortMetricRows(data?.byModel ?? [], modelSort, (row) => row.model),
    [data?.byModel, modelSort],
  );
  const sparklineSeries = useMemo(
    () => buildSparklineSeries(data?.timeSeries ?? [], range),
    [data?.timeSeries, range],
  );

  function toggleSort(current: SortState, key: MetricSortKey) {
    if (current.key === key) {
      return { key, direction: current.direction === "asc" ? "desc" : "asc" as SortDirection };
    }
    return { key, direction: key === "label" ? "asc" : "desc" as SortDirection };
  }

  if (!projectId) {
    return (
      <div className="flex-1 min-h-0 rounded-lg border border-dashed border-gray-300 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-900/40 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">
        Select a project to view insights.
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto pr-1">
      <div className="flex flex-col gap-4 pb-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Agent Performance Insights</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Cost, tokens, success rate, and latency across agent sessions.
            </p>
          </div>
          <div className="inline-flex items-center gap-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-1 shadow-sm">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setRange(option.value)}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors ${range === option.value ? "bg-brand-600 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {loading && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 text-sm text-gray-500 dark:text-gray-400 shadow-sm">
            Loading insights…
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 p-4 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {data && !loading && !error && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              <SummaryCard label="Total Sessions" value={data.totals.sessionCount.toLocaleString("en-US")} subtext={`${formatCompactDate(data.totals.dateFrom)} → ${formatCompactDate(data.totals.dateTo)}`} />
              <SummaryCard label="Success Rate" value={formatSuccessRate(data.totals.successCount, data.totals.sessionCount)} subtext={`${data.totals.successCount.toLocaleString("en-US")} successful`} />
              <SummaryCard label="Total Cost" value={formatCurrency(data.totals.totalCostUsd)} />
              <SummaryCard label="Total Tokens" value={formatTokens(data.totals.totalTokens)} />
            </div>

            <SortableMetricTable
              title="By Skill"
              rows={sortedSkills}
              sort={skillSort}
              onSortChange={(key) => setSkillSort((current) => toggleSort(current, key))}
              getLabel={(row) => row.skillName}
              emptyLabel="No skill-level data in this range."
            />

            <SortableMetricTable
              title="By Model"
              rows={sortedModels}
              sort={modelSort}
              onSortChange={(key) => setModelSort((current) => toggleSort(current, key))}
              getLabel={(row) => row.model}
              emptyLabel="No model-level data in this range."
            />

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <MiniBreakdownTable title="By Issue Type" rows={data.byIssueType} labelKey="issueType" />
              <MiniBreakdownTable title="By Priority" rows={data.byPriority} labelKey="priority" />
            </div>

            <CostSparkline series={sparklineSeries} />

            <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm overflow-hidden">
              <div className="border-b border-gray-200 dark:border-gray-800 px-4 py-3">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Top 10 Most Expensive Sessions</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-gray-950/60 text-gray-600 dark:text-gray-400">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Issue</th>
                      <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Skill</th>
                      <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Model</th>
                      <th className="px-4 py-3 text-right font-medium whitespace-nowrap">Cost</th>
                      <th className="px-4 py-3 text-right font-medium whitespace-nowrap">Tokens</th>
                      <th className="px-4 py-3 text-right font-medium whitespace-nowrap">Turns</th>
                      <th className="px-4 py-3 text-right font-medium whitespace-nowrap">Duration</th>
                      <th className="px-4 py-3 text-right font-medium whitespace-nowrap">Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topExpensive.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">No session stats in this range.</td>
                      </tr>
                    ) : data.topExpensive.map((session) => (
                      <tr
                        key={session.sessionId}
                        className="border-t border-gray-100 dark:border-gray-800/80 text-gray-700 dark:text-gray-300 cursor-pointer hover:bg-brand-50 dark:hover:bg-brand-950/20 transition-colors"
                        onClick={() => onSessionClick(session.sessionId, session.workspaceId, session.issueId)}
                      >
                        <td className="px-4 py-3 text-left">
                          <div className="font-medium text-gray-900 dark:text-gray-100">
                            {session.issueNumber ? `#${session.issueNumber} ` : ""}{session.issueTitle}
                          </div>
                          <div className={`text-xs ${session.success ? "text-emerald-600 dark:text-emerald-400" : "text-gray-500 dark:text-gray-400"}`}>
                            {session.success ? "Successful" : "Needs attention"}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-left">{session.skillName ?? "No Skill"}</td>
                        <td className="px-4 py-3 text-left">{session.model ?? "Unknown"}</td>
                        <td className="px-4 py-3 text-right">{formatCurrency(session.totalCostUsd)}</td>
                        <td className="px-4 py-3 text-right">{formatTokens(session.totalTokens)}</td>
                        <td className="px-4 py-3 text-right">{session.numTurns}</td>
                        <td className="px-4 py-3 text-right">{formatDuration(session.durationMs)}</td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">{formatStartedAt(session.startedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
