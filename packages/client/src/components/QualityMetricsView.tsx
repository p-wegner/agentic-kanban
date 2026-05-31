import { useCallback, useEffect, useMemo, useState } from "react";
import type { QualityMetricRecord, QualityMetricsResponse } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { ACCENT, PRIMARY_SERIES, SEMANTIC, TYPE_COLORS } from "../lib/chartColors.js";

interface QualityMetricsViewProps {
  projectId: string | null;
}

interface Skill {
  id: string;
  name: string;
}

const GROUPS = [
  { id: "size", label: "Size", match: (key: string) => key.startsWith("loc."), color: TYPE_COLORS.feature },
  { id: "tests", label: "Tests", match: (key: string) => key.startsWith("coverage."), color: SEMANTIC.merged },
  { id: "static", label: "Static analysis", match: (key: string) => key.startsWith("lint.") || key.startsWith("typecheck."), color: TYPE_COLORS.bug },
  { id: "other", label: "Other", match: (key: string) => !key.startsWith("loc.") && !key.startsWith("coverage.") && !key.startsWith("lint.") && !key.startsWith("typecheck."), color: PRIMARY_SERIES },
] as const;

function formatValue(metric: QualityMetricRecord) {
  const value = Number.isInteger(metric.value) ? metric.value.toLocaleString("en-US") : metric.value.toFixed(2);
  if (!metric.unit) return value;
  if (metric.unit === "percent" || metric.unit === "%") return `${value}%`;
  return `${value} ${metric.unit}`;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatCommit(value: string | null) {
  return value ? value.slice(0, 8) : "uncommitted";
}

function metricLabel(metricKey: string) {
  return metricKey
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getDelta(metric: QualityMetricRecord, trend: QualityMetricRecord[]) {
  const previous = trend
    .filter((item) => item.metricKey === metric.metricKey && item.id !== metric.id)
    .sort((a, b) => b.collectedAt.localeCompare(a.collectedAt))[0];
  return previous ? metric.value - previous.value : null;
}

function getSeries(metricKey: string, trend: QualityMetricRecord[]) {
  return trend
    .filter((item) => item.metricKey === metricKey)
    .sort((a, b) => a.collectedAt.localeCompare(b.collectedAt));
}

function Sparkline({ series, color }: { series: QualityMetricRecord[]; color: string }) {
  if (series.length < 2) return <div className="h-12 rounded bg-white/70 dark:bg-gray-950/40" />;
  const values = series.map((item) => item.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = series.map((item, index) => {
    const x = (index / (series.length - 1)) * 100;
    const y = 42 - ((item.value - min) / span) * 34;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg viewBox="0 0 100 48" className="h-12 w-full" role="img" aria-label="Metric trend">
      <polyline points={points} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta === null) {
    return <span className="text-xs text-gray-400 dark:text-gray-500">no prior</span>;
  }
  const positive = delta > 0;
  return (
    <span className={`text-xs font-medium ${positive ? "text-emerald-600 dark:text-emerald-400" : delta < 0 ? "text-red-600 dark:text-red-400" : "text-gray-400 dark:text-gray-500"}`}>
      {delta === 0 ? "0" : `${positive ? "+" : ""}${Number.isInteger(delta) ? delta : delta.toFixed(2)}`}
    </span>
  );
}

function metaEntries(meta: unknown): Array<[string, string]> {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return [];
  return Object.entries(meta as Record<string, unknown>)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .slice(0, 4)
    .map(([key, value]) => [key, String(value)]);
}

export function QualityMetricsView({ projectId }: QualityMetricsViewProps) {
  const [data, setData] = useState<QualityMetricsResponse>({ latest: [], trend: [] });
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState("all");

  const fetchMetrics = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch<QualityMetricsResponse>(`/api/projects/${projectId}/quality-metrics`);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load quality metrics");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  const launchCollector = useCallback(async () => {
    if (!projectId) return;
    setRefreshing(true);
    setError(null);
    setNotice(null);
    try {
      const skills = await apiFetch<Skill[]>(`/api/agent-skills?projectId=${projectId}`);
      const skill = skills.find((item) => item.name === "quality-metrics-collector");
      if (!skill) throw new Error("quality-metrics-collector skill is not installed");

      const created = await apiFetch<{ id: string; issueNumber: number; title: string }>("/api/issues", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          title: "Collect quality metrics",
          description: [
            "Collect the latest quality metrics for this project.",
            "",
            `Project ID: ${projectId}`,
            "Post results to the board quality metrics API.",
          ].join("\n"),
          priority: "low",
          issueType: "chore",
          skipAutoReview: true,
        }),
      });

      const branchSlug = `feature/quality-metrics-${created.issueNumber ?? Date.now()}`;
      await apiFetch("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({
          issueId: created.id,
          branch: branchSlug,
          skillId: skill.id,
          planMode: false,
          requiresReview: false,
          skipContextPacker: true,
        }),
      });
      setNotice("Collector workspace launched");
      await fetchMetrics();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch metrics collector");
    } finally {
      setRefreshing(false);
    }
  }, [fetchMetrics, projectId]);

  const metricKeys = useMemo(() => Array.from(new Set(data.trend.map((metric) => metric.metricKey))).sort((a, b) => a.localeCompare(b)), [data.trend]);
  const lastCollected = useMemo(() => data.latest.map((metric) => metric.collectedAt).sort().at(-1) ?? null, [data.latest]);
  const visibleLatest = useMemo(() => selectedKey === "all" ? data.latest : data.latest.filter((metric) => metric.metricKey === selectedKey), [data.latest, selectedKey]);
  const grouped = useMemo(() => GROUPS.map((group) => ({
    ...group,
    metrics: visibleLatest.filter((metric) => group.match(metric.metricKey)),
  })).filter((group) => group.metrics.length > 0), [visibleLatest]);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-white dark:bg-gray-950">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Quality Metrics</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {lastCollected ? `Last collected ${formatTimestamp(lastCollected)}` : "No collected snapshot yet"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={selectedKey}
            onChange={(event) => setSelectedKey(event.target.value)}
            className="text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300"
          >
            <option value="all">All metrics</option>
            {metricKeys.map((key) => <option key={key} value={key}>{metricLabel(key)}</option>)}
          </select>
          <button
            type="button"
            onClick={launchCollector}
            disabled={refreshing || !projectId}
            className="px-3 py-1.5 rounded bg-gray-900 dark:bg-gray-100 text-xs font-medium text-white dark:text-gray-950 disabled:opacity-40"
          >
            {refreshing ? "Launching..." : "Refresh metrics"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-5">
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}
        {notice && (
          <div className="p-3 bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 rounded text-sm text-emerald-700 dark:text-emerald-300">
            {notice}
          </div>
        )}

        {!loading && !error && data.trend.length === 0 && (
          <div className="flex flex-col items-center justify-center h-52 text-gray-400 dark:text-gray-600 text-sm gap-2">
            <span className="text-2xl font-semibold" style={{ color: ACCENT }}>QM</span>
            <span>No quality metrics recorded yet</span>
          </div>
        )}

        {grouped.map((group) => (
          <section key={group.id} className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{group.label}</h3>
              <span className="text-[11px] text-gray-400 dark:text-gray-500">{group.metrics.length} metrics</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {group.metrics.map((metric) => {
                const delta = getDelta(metric, data.trend);
                const series = getSeries(metric.metricKey, data.trend);
                const entries = metaEntries(metric.meta);
                return (
                  <div key={metric.id} className="border border-gray-200 dark:border-gray-800 rounded-lg p-3 bg-gray-50 dark:bg-gray-900">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs text-gray-500 dark:text-gray-400 truncate" title={metric.metricKey}>
                          {metricLabel(metric.metricKey)}
                        </div>
                        <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                          {formatValue(metric)}
                        </div>
                      </div>
                      <DeltaBadge delta={delta} />
                    </div>
                    <div className="mt-2">
                      <Sparkline series={series} color={group.color || PRIMARY_SERIES} />
                    </div>
                    {entries.length > 0 && (
                      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
                        {entries.map(([key, value]) => (
                          <div key={key} className="min-w-0">
                            <span className="text-gray-400 dark:text-gray-500">{key}: </span>
                            <span className="truncate">{value}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="mt-3 flex items-center justify-between text-[11px] text-gray-500 dark:text-gray-400">
                      <span>{formatTimestamp(metric.collectedAt)}</span>
                      <span className="font-mono">{formatCommit(metric.commitSha)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
