import { useCallback, useEffect, useMemo, useState } from "react";
import type { QualityMetricRecord, QualityMetricsResponse } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";

interface QualityMetricsViewProps {
  projectId: string | null;
}

function formatValue(metric: QualityMetricRecord) {
  const value = Number.isInteger(metric.value) ? metric.value.toLocaleString("en-US") : metric.value.toFixed(2);
  if (!metric.unit) return value;
  if (metric.unit === "percent") return `${value}%`;
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
  const history = trend
    .filter((item) => item.metricKey === metric.metricKey && item.id !== metric.id)
    .sort((a, b) => b.collectedAt.localeCompare(a.collectedAt));
  const previous = history[0];
  if (!previous) return null;
  return metric.value - previous.value;
}

function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta === null || delta === 0) {
    return <span className="text-xs text-gray-400 dark:text-gray-500">no prior</span>;
  }
  const positive = delta > 0;
  return (
    <span className={`text-xs font-medium ${positive ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
      {positive ? "+" : ""}{Number.isInteger(delta) ? delta : delta.toFixed(2)}
    </span>
  );
}

export function QualityMetricsView({ projectId }: QualityMetricsViewProps) {
  const [data, setData] = useState<QualityMetricsResponse>({ latest: [], trend: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const metricKeys = useMemo(() => {
    return Array.from(new Set(data.trend.map((metric) => metric.metricKey))).sort((a, b) => a.localeCompare(b));
  }, [data.trend]);

  const visibleLatest = useMemo(() => {
    return selectedKey === "all" ? data.latest : data.latest.filter((metric) => metric.metricKey === selectedKey);
  }, [data.latest, selectedKey]);

  const visibleTrend = useMemo(() => {
    const trend = selectedKey === "all" ? data.trend : data.trend.filter((metric) => metric.metricKey === selectedKey);
    return [...trend].sort((a, b) => b.collectedAt.localeCompare(a.collectedAt));
  }, [data.trend, selectedKey]);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-white dark:bg-gray-950">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Quality Metrics</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {data.latest.length} current metrics, {data.trend.length} recorded samples
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
            onClick={fetchMetrics}
            disabled={loading || !projectId}
            className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 disabled:opacity-40"
            title="Refresh"
          >
            <svg className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {!loading && !error && data.trend.length === 0 && (
          <div className="flex flex-col items-center justify-center h-52 text-gray-400 dark:text-gray-600 text-sm gap-2">
            <span className="text-2xl">QM</span>
            <span>No quality metrics recorded yet</span>
          </div>
        )}

        {visibleLatest.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            {visibleLatest.map((metric) => {
              const delta = getDelta(metric, data.trend);
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
                  <div className="mt-3 flex items-center justify-between text-[11px] text-gray-500 dark:text-gray-400">
                    <span>{formatTimestamp(metric.collectedAt)}</span>
                    <span className="font-mono">{formatCommit(metric.commitSha)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {visibleTrend.length > 0 && (
          <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
              <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">Recorded Samples</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Metric</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400">Value</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Collected</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Commit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {visibleTrend.map((metric) => (
                    <tr key={metric.id} className="hover:bg-gray-50 dark:hover:bg-gray-900">
                      <td className="px-3 py-2 text-gray-800 dark:text-gray-200">
                        <div className="font-medium">{metricLabel(metric.metricKey)}</div>
                        <div className="text-xs text-gray-400 dark:text-gray-500 font-mono">{metric.metricKey}</div>
                      </td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                        {formatValue(metric)}
                      </td>
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {formatTimestamp(metric.collectedAt)}
                      </td>
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400 font-mono whitespace-nowrap">
                        {formatCommit(metric.commitSha)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
