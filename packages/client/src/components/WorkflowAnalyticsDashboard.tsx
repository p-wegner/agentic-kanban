import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api.js";

interface NodeStat {
  nodeId: string;
  templateId: string | null;
  templateName: string | null;
  nodeName: string;
  nodeType: string;
  sortOrder: number;
  visits: number;
  avgDwellMs: number | null;
  dropoff: number;
}

interface DurationTrend {
  date: string;
  nodeId: string;
  nodeName: string;
  avgDwellMs: number;
  samples: number;
}

interface FunnelStage {
  nodeId: string;
  templateId: string | null;
  templateName: string | null;
  nodeName: string;
  nodeType: string;
  sortOrder: number;
  entered: number;
  advanced: number;
  dropoff: number;
  conversionRate: number;
}

interface BurnDownPoint {
  date: string;
  started: number;
  completed: number;
  remaining: number;
}

interface Analytics {
  totalWorkspaces: number;
  nodes: NodeStat[];
  durationTrends: DurationTrend[];
  funnel: FunnelStage[];
  burnDown: BurnDownPoint[];
}

const SERIES_COLORS = ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2"];

function fmtDwell(ms: number | null): string {
  if (ms == null) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function fmtDate(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function StatTile({ label, value, sub }: { label: string; value: string | number; sub: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{value}</div>
      <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{sub}</div>
    </div>
  );
}

function EmptyChart({ children }: { children: string }) {
  return (
    <div className="flex h-48 items-center justify-center rounded-md border border-dashed border-gray-200 text-sm text-gray-400 dark:border-gray-700 dark:text-gray-500">
      {children}
    </div>
  );
}

function DurationTrendChart({ trends }: { trends: DurationTrend[] }) {
  const chart = useMemo(() => {
    const dates = [...new Set(trends.map((trend) => trend.date))].sort();
    const nodes = [...new Map(trends.map((trend) => [trend.nodeId, trend.nodeName])).entries()].slice(0, 6);
    const maxMs = Math.max(...trends.map((trend) => trend.avgDwellMs), 1);
    return { dates, nodes, maxMs };
  }, [trends]);

  if (trends.length === 0 || chart.dates.length === 0) {
    return <EmptyChart>No duration samples yet</EmptyChart>;
  }

  const width = 760;
  const height = 220;
  const padX = 40;
  const padTop = 18;
  const padBottom = 32;
  const plotW = width - padX * 2;
  const plotH = height - padTop - padBottom;
  const x = (date: string) => {
    const index = chart.dates.indexOf(date);
    return padX + (chart.dates.length === 1 ? plotW / 2 : (index / (chart.dates.length - 1)) * plotW);
  };
  const y = (ms: number) => padTop + plotH - (ms / chart.maxMs) * plotH;

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-56 w-full overflow-visible">
        <line x1={padX} y1={padTop + plotH} x2={width - padX} y2={padTop + plotH} stroke="#d1d5db" />
        <line x1={padX} y1={padTop} x2={padX} y2={padTop + plotH} stroke="#d1d5db" />
        {[0, 0.5, 1].map((tick) => (
          <g key={tick}>
            <line x1={padX} x2={width - padX} y1={padTop + plotH - tick * plotH} y2={padTop + plotH - tick * plotH} stroke="#e5e7eb" />
            <text x={8} y={padTop + plotH - tick * plotH + 4} className="fill-gray-500 text-[11px] dark:fill-gray-400">
              {fmtDwell(chart.maxMs * tick)}
            </text>
          </g>
        ))}
        {chart.nodes.map(([nodeId, nodeName], index) => {
          const points = trends
            .filter((trend) => trend.nodeId === nodeId)
            .sort((a, b) => a.date.localeCompare(b.date))
            .map((trend) => `${x(trend.date)},${y(trend.avgDwellMs)}`)
            .join(" ");
          return (
            <g key={nodeId}>
              <polyline points={points} fill="none" stroke={SERIES_COLORS[index]} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
              {trends.filter((trend) => trend.nodeId === nodeId).map((trend) => (
                <circle key={`${trend.nodeId}-${trend.date}`} cx={x(trend.date)} cy={y(trend.avgDwellMs)} r="4" fill={SERIES_COLORS[index]}>
                  <title>{`${nodeName}: ${fmtDwell(trend.avgDwellMs)} on ${fmtDate(trend.date)} (${trend.samples} samples)`}</title>
                </circle>
              ))}
            </g>
          );
        })}
        {chart.dates.map((date) => (
          <text key={date} x={x(date)} y={height - 8} textAnchor="middle" className="fill-gray-500 text-[11px] dark:fill-gray-400">
            {fmtDate(date)}
          </text>
        ))}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {chart.nodes.map(([nodeId, nodeName], index) => (
          <div key={nodeId} className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: SERIES_COLORS[index] }} />
            <span>{nodeName}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FunnelChart({ stages }: { stages: FunnelStage[] }) {
  if (stages.length === 0) return <EmptyChart>No funnel stages yet</EmptyChart>;

  const maxEntered = Math.max(...stages.map((stage) => stage.entered), 1);
  return (
    <div className="space-y-3">
      {stages.map((stage) => {
        const width = Math.max(4, (stage.entered / maxEntered) * 100);
        return (
          <div key={stage.nodeId} className="grid grid-cols-[minmax(7rem,11rem)_1fr_auto] items-center gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-gray-800 dark:text-gray-100" title={stage.nodeName}>{stage.nodeName}</div>
              <div className="truncate text-xs text-gray-500 dark:text-gray-400">{stage.templateName ?? stage.nodeType}</div>
            </div>
            <div className="h-8 rounded-md bg-gray-100 dark:bg-gray-800">
              <div
                className="flex h-8 items-center justify-end rounded-md bg-blue-600 pr-2 text-xs font-medium text-white"
                style={{ width: `${width}%` }}
                title={`${stage.entered} entered, ${stage.advanced} advanced, ${stage.dropoff} dropped off`}
              >
                {stage.entered}
              </div>
            </div>
            <div className="w-24 text-right text-xs">
              <div className="font-semibold text-gray-700 dark:text-gray-200">{stage.conversionRate}%</div>
              <div className={stage.dropoff > 0 ? "text-amber-600 dark:text-amber-400" : "text-gray-400 dark:text-gray-500"}>
                {stage.dropoff} drop-off
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BurnDownChart({ points }: { points: BurnDownPoint[] }) {
  if (points.length === 0) return <EmptyChart>No workflow completions yet</EmptyChart>;

  const width = 760;
  const height = 220;
  const padX = 40;
  const padTop = 18;
  const padBottom = 32;
  const plotW = width - padX * 2;
  const plotH = height - padTop - padBottom;
  const maxRemaining = Math.max(...points.map((point) => point.remaining), 1);
  const x = (index: number) => padX + (points.length === 1 ? plotW / 2 : (index / (points.length - 1)) * plotW);
  const y = (remaining: number) => padTop + plotH - (remaining / maxRemaining) * plotH;
  const polyline = points.map((point, index) => `${x(index)},${y(point.remaining)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-56 w-full overflow-visible">
      <line x1={padX} y1={padTop + plotH} x2={width - padX} y2={padTop + plotH} stroke="#d1d5db" />
      <line x1={padX} y1={padTop} x2={padX} y2={padTop + plotH} stroke="#d1d5db" />
      {[0, 0.5, 1].map((tick) => (
        <g key={tick}>
          <line x1={padX} x2={width - padX} y1={padTop + plotH - tick * plotH} y2={padTop + plotH - tick * plotH} stroke="#e5e7eb" />
          <text x={14} y={padTop + plotH - tick * plotH + 4} className="fill-gray-500 text-[11px] dark:fill-gray-400">
            {Math.round(maxRemaining * tick)}
          </text>
        </g>
      ))}
      <polyline points={polyline} fill="none" stroke="#059669" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((point, index) => (
        <circle key={point.date} cx={x(index)} cy={y(point.remaining)} r="4" fill="#059669">
          <title>{`${point.remaining} remaining on ${fmtDate(point.date)} (${point.completed}/${point.started} completed)`}</title>
        </circle>
      ))}
      {points.map((point, index) => (
        <text key={point.date} x={x(index)} y={height - 8} textAnchor="middle" className="fill-gray-500 text-[11px] dark:fill-gray-400">
          {fmtDate(point.date)}
        </text>
      ))}
    </svg>
  );
}

export function WorkflowAnalyticsDashboard({ projectId }: { projectId: string }) {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Analytics>(`/api/workflows/analytics?projectId=${encodeURIComponent(projectId)}`)
      .then((data) => {
        if (!cancelled) {
          setAnalytics(data);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setAnalytics(null);
          setError(err instanceof Error ? err.message : "Failed to load workflow analytics");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const summary = useMemo(() => {
    const slowest = analytics?.nodes
      .filter((node) => node.avgDwellMs != null)
      .sort((a, b) => (b.avgDwellMs ?? 0) - (a.avgDwellMs ?? 0))[0];
    const dropoffs = analytics?.nodes.reduce((total, node) => total + node.dropoff, 0) ?? 0;
    const latestBurn = analytics?.burnDown.at(-1);
    return { slowest, dropoffs, latestBurn };
  }, [analytics]);

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-red-600 dark:text-red-400">
        {error}
      </div>
    );
  }

  if (!analytics) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-gray-400 dark:text-gray-500">
        Loading workflow analytics...
      </div>
    );
  }

  if (analytics.totalWorkspaces === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-gray-400 dark:text-gray-500">
        No workflow activity yet.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto px-4 pb-6">
      <div className="mx-auto max-w-6xl space-y-5 pt-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Workflow Analytics</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Stage duration, funnel drop-off, and workflow burn-down from node transition history.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Workflow Workspaces" value={analytics.totalWorkspaces} sub="with node transition history" />
          <StatTile label="Tracked Stages" value={analytics.nodes.length} sub="visited workflow nodes" />
          <StatTile label="Open Burn-Down" value={summary.latestBurn?.remaining ?? 0} sub="started minus completed" />
          <StatTile label="Drop-Off" value={summary.dropoffs} sub="current non-terminal stages" />
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
          <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900 xl:col-span-3">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Per-Node Duration Trends</h3>
              {summary.slowest && (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  Slowest avg: {summary.slowest.nodeName} / {fmtDwell(summary.slowest.avgDwellMs)}
                </span>
              )}
            </div>
            <DurationTrendChart trends={analytics.durationTrends} />
          </div>

          <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900 xl:col-span-2">
            <h3 className="mb-3 text-sm font-semibold text-gray-800 dark:text-gray-100">Burn-Down Over Time</h3>
            <BurnDownChart points={analytics.burnDown} />
          </div>
        </div>

        <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <h3 className="mb-3 text-sm font-semibold text-gray-800 dark:text-gray-100">Drop-Off Funnel</h3>
          <FunnelChart stages={analytics.funnel} />
        </div>
      </div>
    </div>
  );
}
