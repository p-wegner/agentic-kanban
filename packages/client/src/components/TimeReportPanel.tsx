import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";

type Range = "7d" | "30d" | "90d" | "all";
type SortKey = "minutes" | "issueNumber" | "title";
type SortDir = "asc" | "desc";

interface TimeReportByIssue {
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  totalMinutes: number;
}

interface TimeReportByDay {
  date: string;
  totalMinutes: number;
}

interface TimeReportData {
  byIssue: TimeReportByIssue[];
  byDay: TimeReportByDay[];
  totalMinutes: number;
  dateFrom: string;
  dateTo: string;
}

interface TimeReportPanelProps {
  projectId: string;
  onClose: () => void;
}

const RANGE_LABELS: Record<Range, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "all": "All time",
};

function formatMinutes(minutes: number): string {
  if (minutes === 0) return "0m";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function TimeReportPanel({ projectId, onClose }: TimeReportPanelProps) {
  const [data, setData] = useState<TimeReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("30d");
  const [sortKey, setSortKey] = useState<SortKey>("minutes");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const load = useCallback(async (r: Range) => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch<TimeReportData>(`/api/projects/${projectId}/time-report?range=${r}`);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load time report");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load(range);
  }, [load, range]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "minutes" ? "desc" : "asc");
    }
  }

  const sortedByIssue = data
    ? [...data.byIssue].sort((a, b) => {
        let cmp = 0;
        if (sortKey === "minutes") cmp = a.totalMinutes - b.totalMinutes;
        else if (sortKey === "issueNumber") cmp = (a.issueNumber ?? 0) - (b.issueNumber ?? 0);
        else cmp = a.issueTitle.localeCompare(b.issueTitle);
        return sortDir === "asc" ? cmp : -cmp;
      })
    : [];

  const maxDayMinutes = data ? Math.max(...data.byDay.map((d) => d.totalMinutes), 1) : 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-16 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-2xl rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Time Report</h2>
          <div className="flex items-center gap-2">
            {/* Range selector */}
            <div className="flex items-center gap-0 border border-gray-200 dark:border-gray-700 rounded-md p-0.5 bg-gray-50 dark:bg-gray-800">
              {(Object.keys(RANGE_LABELS) as Range[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={`px-2 py-0.5 text-xs rounded transition-colors ${
                    range === r
                      ? "bg-brand-600 text-white"
                      : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                  }`}
                >
                  {r === "all" ? "All" : r}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => load(range)}
              className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-2 py-1 rounded"
              title="Refresh"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              aria-label="Close time report"
            >
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 p-4 space-y-5">
          {loading && (
            <div className="flex items-center justify-center py-12 text-gray-400">
              <svg className="animate-spin h-5 w-5 mr-2" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Loading...
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </div>
          )}

          {!loading && !error && data && data.totalMinutes === 0 && (
            <p className="text-center py-10 text-gray-400 text-sm">
              No time entries for {RANGE_LABELS[range].toLowerCase()}.
            </p>
          )}

          {!loading && !error && data && data.totalMinutes > 0 && (
            <>
              {/* Summary */}
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold text-gray-900 dark:text-gray-100">{formatMinutes(data.totalMinutes)}</span>
                <span className="text-sm text-gray-500 dark:text-gray-400">logged — {RANGE_LABELS[range].toLowerCase()}</span>
              </div>

              {/* Per-day chart */}
              {data.byDay.length > 1 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">Daily Totals</p>
                  <div className="flex items-end gap-1 h-16">
                    {data.byDay.map((day) => {
                      const pct = maxDayMinutes > 0 ? (day.totalMinutes / maxDayMinutes) * 100 : 0;
                      return (
                        <div key={day.date} className="flex-1 flex flex-col items-center gap-0.5 group relative" title={`${formatDate(day.date)}: ${formatMinutes(day.totalMinutes)}`}>
                          <div
                            className="w-full rounded-t transition-colors bg-brand-400 dark:bg-brand-600 group-hover:bg-brand-500 dark:group-hover:bg-brand-500"
                            style={{ height: `${Math.max(pct, day.totalMinutes > 0 ? 4 : 0)}%` }}
                          />
                          <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 pointer-events-none hidden group-hover:block bg-gray-900 text-white text-[10px] rounded px-1.5 py-0.5 whitespace-nowrap z-10">
                            {formatDate(day.date)}: {formatMinutes(day.totalMinutes)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex justify-between text-[10px] text-gray-400 dark:text-gray-500 mt-1">
                    <span>{formatDate(data.byDay[0].date)}</span>
                    <span>{formatDate(data.byDay[data.byDay.length - 1].date)}</span>
                  </div>
                </div>
              )}

              {/* Per-issue table */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">By Issue</p>
                <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 dark:bg-gray-800">
                      <tr>
                        <SortHeader label="#" sortKey="issueNumber" current={sortKey} dir={sortDir} onSort={toggleSort} className="w-12 text-left px-3 py-2" />
                        <SortHeader label="Issue" sortKey="title" current={sortKey} dir={sortDir} onSort={toggleSort} className="text-left px-3 py-2" />
                        <SortHeader label="Time" sortKey="minutes" current={sortKey} dir={sortDir} onSort={toggleSort} className="w-20 text-right px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {sortedByIssue.map((row) => (
                        <tr key={row.issueId} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                          <td className="px-3 py-2 font-mono text-gray-400 dark:text-gray-500">
                            {row.issueNumber != null ? `#${row.issueNumber}` : "—"}
                          </td>
                          <td className="px-3 py-2 text-gray-700 dark:text-gray-300 truncate max-w-0" style={{ maxWidth: 1 }}>
                            <span className="block truncate" title={row.issueTitle}>{row.issueTitle}</span>
                          </td>
                          <td className="px-3 py-2 text-right font-medium text-gray-900 dark:text-gray-100 tabular-nums">
                            {formatMinutes(row.totalMinutes)}
                          </td>
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
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  current,
  dir,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const isActive = current === sortKey;
  return (
    <th className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`flex items-center gap-0.5 font-semibold uppercase tracking-wide transition-colors ${
          isActive ? "text-brand-600 dark:text-brand-400" : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
        }`}
      >
        {label}
        {isActive && (
          <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            {dir === "asc"
              ? <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
              : <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />}
          </svg>
        )}
      </button>
    </th>
  );
}
