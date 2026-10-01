import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ContributionGroupBy, ContributionsResponse } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { useViewTab } from "../hooks/useViewTab.js";
import { CONTRIBUTIONS_TABS, CONTRIBUTIONS_VIEW_ID, type ContributionsTabId } from "../lib/viewTabs.js";
import {
  CONTRIBUTION_METRICS,
  CONTRIBUTION_RANGES,
  DEFAULT_CHART_METRIC,
  barPercent,
  contributionsParams,
  formatMetric,
  parseRangeSearch,
  resolveRangeWindow,
  sortContributionRows,
  type ContributionMetricKey,
  type ContributionSort,
  type RangeSelection,
} from "../lib/contributions.js";
import { ViewTabBar } from "./ViewTabBar.js";

interface ContributionsViewProps {
  projectId: string;
}

/**
 * Contributions (#1264): who contributed how much â€” a sortable per-actor table plus a bar
 * chart of one metric. The grouping is the URL tab (`/contributions/<groupBy>`); the time
 * range is component state, seeded from `?range=7d|30d|custom&from=&to=` on mount.
 * Both filters are applied by the server.
 */
export function ContributionsView({ projectId }: ContributionsViewProps) {
  const [groupBy, selectGroupBy] = useViewTab<ContributionsTabId>(CONTRIBUTIONS_VIEW_ID);
  const [selection, setSelection] = useState<RangeSelection>(() =>
    parseRangeSearch(typeof window === "undefined" ? "" : window.location.search),
  );
  const [sort, setSort] = useState<ContributionSort>({ key: DEFAULT_CHART_METRIC, dir: "desc" });
  const [chartMetric, setChartMetric] = useState<ContributionMetricKey>(DEFAULT_CHART_METRIC);

  const updateSelection = setSelection;

  const window_ = useMemo(() => resolveRangeWindow(selection, Date.now()), [selection]);
  const { data, isLoading, error } = useQuery({
    queryKey: ["projects", projectId, "contributions", groupBy, window_.from ?? null, window_.to ?? null],
    queryFn: () => apiFetch<ContributionsResponse>(`/api/projects/${projectId}/contributions?${contributionsParams(groupBy, window_)}`, { method: "GET" }),
    staleTime: 15_000,
  });

  const rows = useMemo(() => sortContributionRows(data?.actors ?? [], sort), [data, sort]);
  const metric = CONTRIBUTION_METRICS.find((m) => m.key === chartMetric) ?? CONTRIBUTION_METRICS[0];
  const chartMax = Math.max(0, ...rows.map((r) => r[metric.key] ?? 0));

  const toggleSort = (key: ContributionSort["key"]) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: key === "actor" ? "asc" : "desc" }));
  const arrow = (key: ContributionSort["key"]) => (sort.key === key ? (sort.dir === "desc" ? " â–¾" : " â–´") : "");

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden" data-testid="contributions-view">
      <ViewTabBar tabs={CONTRIBUTIONS_TABS} active={groupBy} onSelect={selectGroupBy} />
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-gray-400">Range</span>
          {CONTRIBUTION_RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => updateSelection({ ...selection, range: r.id })}
              className={`px-2 py-1 rounded border ${selection.range === r.id ? "bg-brand-600 border-brand-500 text-white" : "border-gray-700 text-gray-300 hover:bg-gray-800"}`}
            >
              {r.label}
            </button>
          ))}
          {selection.range === "custom" && (
            <>
              <input
                type="date"
                aria-label="From date"
                value={selection.customFrom}
                onChange={(e) => updateSelection({ ...selection, customFrom: e.target.value })}
                className="px-2 py-1 rounded border border-gray-700 bg-gray-900 text-gray-200"
              />
              <span className="text-gray-500">â€“</span>
              <input
                type="date"
                aria-label="To date"
                value={selection.customTo}
                onChange={(e) => updateSelection({ ...selection, customTo: e.target.value })}
                className="px-2 py-1 rounded border border-gray-700 bg-gray-900 text-gray-200"
              />
            </>
          )}
        </div>

        {isLoading && <p className="text-sm text-gray-400">Loading contributionsâ€¦</p>}
        {error && <p className="text-sm text-red-400">Could not load contributions: {(error as Error).message}</p>}
        {data && rows.length === 0 && (
          <p className="text-sm text-gray-400" data-testid="contributions-empty">
            No contributions yet for this range. Sessions, workspaces and merges show up here once agents have worked on the project.
          </p>
        )}

        {rows.length > 0 && (
          <>
            <section aria-label="Contribution chart" className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-gray-400">
                Chart metric
                <select
                  value={chartMetric}
                  onChange={(e) => setChartMetric(e.target.value as ContributionMetricKey)}
                  className="px-2 py-1 rounded border border-gray-700 bg-gray-900 text-gray-200"
                >
                  {CONTRIBUTION_METRICS.map((m) => (
                    <option key={m.key} value={m.key}>{m.label}</option>
                  ))}
                </select>
              </label>
              <ul className="space-y-1">
                {rows.map((r) => (
                  <li key={r.actor} className="flex items-center gap-2 text-sm">
                    <span className="w-40 shrink-0 truncate text-gray-300" title={r.actor}>{r.actor}</span>
                    <div className="flex-1 h-4 rounded bg-gray-800 overflow-hidden">
                      <div
                        className="h-full bg-brand-500"
                        style={{ width: `${barPercent(r[metric.key], chartMax)}%` }}
                        data-testid={`bar-${r.actor}`}
                      />
                    </div>
                    <span className="w-24 shrink-0 text-right tabular-nums text-gray-300">{formatMetric(r[metric.key], metric.kind)}</span>
                  </li>
                ))}
              </ul>
            </section>

            <div className="overflow-x-auto">
              <table className="min-w-full text-sm text-left">
                <thead className="text-gray-400 border-b border-gray-700">
                  <tr>
                    <th className="py-1 pr-3 cursor-pointer select-none" onClick={() => toggleSort("actor")}>
                      {CONTRIBUTIONS_TABS.find((t) => t.id === groupBy)?.label}{arrow("actor")}
                    </th>
                    {CONTRIBUTION_METRICS.map((m) => (
                      <th key={m.key} className="py-1 px-2 text-right cursor-pointer select-none whitespace-nowrap" onClick={() => toggleSort(m.key)}>
                        {m.label}{arrow(m.key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.actor} className="border-b border-gray-800">
                      <td className={`py-1 pr-3 ${r.unset ? "italic text-gray-400" : "text-gray-200"}`}>{r.actor}</td>
                      {CONTRIBUTION_METRICS.map((m) => (
                        <td key={m.key} className="py-1 px-2 text-right tabular-nums text-gray-300">{formatMetric(r[m.key], m.kind)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
