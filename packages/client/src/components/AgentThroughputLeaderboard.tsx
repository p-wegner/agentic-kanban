import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { BRAND, ACCENT, SEMANTIC } from "../lib/chartColors.js";

interface ProviderEntry {
  provider: string;
  profile: string;
  count: number;
  medianLeadTimeMs: number | null;
}

interface ThroughputData {
  providers: ProviderEntry[];
  window: string;
  overallMedianLeadTimeMs: number | null;
}

/** Stable color per provider key, drawn from the chartColors palette. */
const PROVIDER_COLORS: Record<string, string> = {
  claude:  BRAND,           // terracotta
  codex:   ACCENT,          // sage
  copilot: SEMANTIC.created, // muted slate-teal
  unknown: "#b3a89a",       // warm neutral gray
};

function providerColor(key: string): string {
  return PROVIDER_COLORS[key.toLowerCase()] ?? "#8a8175";
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return "—";
  const h = ms / (1000 * 60 * 60);
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  return d < 10 ? `${d.toFixed(1)}d` : `${Math.round(d)}d`;
}

function providerLabel(entry: ProviderEntry): string {
  if (entry.profile) return `${entry.provider}:${entry.profile}`;
  return entry.provider;
}

export function AgentThroughputLeaderboard({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ThroughputData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<7 | 14 | 30>(14);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<ThroughputData>(
      `/api/projects/${encodeURIComponent(projectId)}/dashboard/throughput-by-provider?days=${days}`
    )
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err instanceof Error ? err.message : "Failed to load throughput data"); setLoading(false); } });
    return () => { cancelled = true; };
  }, [projectId, days, retryKey]);

  const stats = useMemo(() => {
    if (!data || data.providers.length === 0) return null;
    const total = data.providers.reduce((s, p) => s + p.count, 0);
    const maxCount = Math.max(...data.providers.map((p) => p.count), 1);
    return { total, maxCount };
  }, [data]);

  return (
    <div className="flex-1 overflow-auto px-4 pb-6">
      <div className="mx-auto max-w-4xl space-y-5 pt-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Agent Throughput Leaderboard
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Issues merged to master, ranked by agent provider. Count + median lead time.
            </p>
          </div>
          <div className="flex gap-1">
            {([7, 14, 30] as const).map((w) => (
              <button
                key={w}
                onClick={() => setDays(w)}
                className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                  days === w
                    ? "bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900"
                    : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                }`}
              >
                {w}d
              </button>
            ))}
          </div>
        </div>

        {loading && (
          <div className="flex h-64 items-center justify-center text-sm text-gray-400 dark:text-gray-500">
            Loading throughput data...
          </div>
        )}

        {!loading && error && (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-sm text-red-600 dark:text-red-400">
            <span>{error}</span>
            <button
              onClick={() => { setError(null); setRetryKey((k) => k + 1); }}
              className="rounded bg-red-100 px-3 py-1 text-xs text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && stats && data && (
          <>
            {/* Summary tiles */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                  Issues Merged
                </div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
                  {stats.total}
                </div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">last {days} days</div>
              </div>
              <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                  Providers Active
                </div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
                  {data.providers.length}
                </div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">agent types</div>
              </div>
              <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                  Overall Median Lead
                </div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
                  {fmtDuration(data.overallMedianLeadTimeMs)}
                </div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">creation → Done</div>
              </div>
            </div>

            {/* Leaderboard table */}
            <div className="rounded-md border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 dark:border-gray-800">
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                        Rank
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                        Provider
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                        Issues Merged
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                        Median Lead Time
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500 dark:text-gray-400 w-32">
                        Share
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.providers.map((entry, idx) => {
                      const pct = stats.total > 0 ? (entry.count / stats.total) * 100 : 0;
                      const barPct = stats.maxCount > 0 ? (entry.count / stats.maxCount) * 100 : 0;
                      return (
                        <tr
                          key={`${entry.provider}:${entry.profile}`}
                          className={idx < data.providers.length - 1 ? "border-b border-gray-50 dark:border-gray-800/50" : ""}
                        >
                          <td className="px-4 py-3">
                            <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                              idx === 0
                                ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                                : idx === 1
                                  ? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                                  : idx === 2
                                    ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300"
                                    : "text-gray-400 dark:text-gray-500"
                            }`}>
                              {idx + 1}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <span
                                className="h-2.5 w-2.5 rounded-sm flex-shrink-0"
                                style={{ backgroundColor: providerColor(entry.provider) }}
                              />
                              <span className="font-medium text-gray-900 dark:text-gray-100">
                                {entry.provider}
                              </span>
                              {entry.profile && (
                                <span className="text-gray-400 dark:text-gray-500">:{entry.profile}</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                            {entry.count}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-300">
                            {fmtDuration(entry.medianLeadTimeMs)}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="h-2 flex-1 rounded-full bg-gray-100 dark:bg-gray-800">
                                <div
                                  className="h-2 rounded-full transition-all"
                                  style={{
                                    width: `${barPct}%`,
                                    backgroundColor: providerColor(entry.provider),
                                  }}
                                />
                              </div>
                              <span className="text-xs tabular-nums text-gray-400 dark:text-gray-500 w-10 text-right">
                                {Math.round(pct)}%
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {!loading && !error && !stats && (
          <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-gray-200 text-sm text-gray-400 dark:border-gray-700 dark:text-gray-500">
            <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h4v7H3zM10 8h4v11h-4zM17 4h4v15h-4zM3 19h18" />
            </svg>
            <span>No issues merged in the last {days} days</span>
          </div>
        )}
      </div>
    </div>
  );
}
