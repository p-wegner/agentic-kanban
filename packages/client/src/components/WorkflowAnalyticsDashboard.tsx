import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { STATUS_COLORS } from "../lib/chartColors.js";

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

interface CfdPoint {
  date: string;
  status: string;
  count: number;
}

interface CfdData {
  statuses: string[];
  counts: CfdPoint[];
}

type CfdWindow = 7 | 30 | 90;

function fallbackColor(index: number): string {
  const fallbacks = ["#a8a195", "#8a8175", "#c25f36", "#d17d54", "#719161", "#547446", "#b3a89a"];
  return fallbacks[index % fallbacks.length];
}

function CumulativeFlowChart({ projectId }: { projectId: string }) {
  const [days, setDays] = useState<CfdWindow>(30);
  const [data, setData] = useState<CfdData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<CfdData>(`/api/issues/cfd?projectId=${encodeURIComponent(projectId)}&days=${days}`)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled) { setData(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [projectId, days]);

  const chart = useMemo(() => {
    if (!data || data.counts.length === 0) return null;

    const dates = [...new Set(data.counts.map((c) => c.date))].sort();
    const statuses = data.statuses;

    // Build per-date, per-status count map.
    const byDateStatus = new Map<string, Map<string, number>>();
    for (const pt of data.counts) {
      if (!byDateStatus.has(pt.date)) byDateStatus.set(pt.date, new Map());
      byDateStatus.get(pt.date)!.set(pt.status, pt.count);
    }

    // Max total for y-axis.
    let maxTotal = 0;
    for (const date of dates) {
      let total = 0;
      for (const s of statuses) total += byDateStatus.get(date)?.get(s) ?? 0;
      if (total > maxTotal) maxTotal = total;
    }
    if (maxTotal === 0) return null;

    return { dates, statuses, byDateStatus, maxTotal };
  }, [data]);

  const svgW = 760;
  const svgH = 220;
  const padX = 44;
  const padTop = 12;
  const padBottom = 32;
  const plotW = svgW - padX * 2;
  const plotH = svgH - padTop - padBottom;

  const xOf = (index: number, total: number) =>
    padX + (total === 1 ? plotW / 2 : (index / (total - 1)) * plotW);
  const yOf = (value: number, max: number) =>
    padTop + plotH - (value / max) * plotH;

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-gray-400 dark:text-gray-500">
        Loading…
      </div>
    );
  }

  if (!chart) {
    return <EmptyChart>No issue history in this period</EmptyChart>;
  }

  const { dates, statuses, byDateStatus, maxTotal } = chart;

  // Build stacked area paths (bottom-up stacking).
  const stackedPaths = statuses.map((status, si) => {
    // Compute cumulative floor for this band.
    const lowerStatuses = statuses.slice(0, si);
    const points = dates.map((date, di) => {
      const floor = lowerStatuses.reduce((sum, s) => sum + (byDateStatus.get(date)?.get(s) ?? 0), 0);
      const top = floor + (byDateStatus.get(date)?.get(status) ?? 0);
      return { x: xOf(di, dates.length), yFloor: yOf(floor, maxTotal), yTop: yOf(top, maxTotal) };
    });

    const polygonPoints = [
      ...points.map((p) => `${p.x},${p.yTop}`),
      ...[...points].reverse().map((p) => `${p.x},${p.yFloor}`),
    ].join(" ");

    const color = STATUS_COLORS[status] ?? fallbackColor(si);
    return { status, polygonPoints, color, topPoints: points.map((p) => `${p.x},${p.yTop}`).join(" ") };
  });

  // Date labels: show at most 8 evenly-spaced labels.
  const labelStep = Math.max(1, Math.floor(dates.length / 8));
  const labelDates = dates.filter((_, i) => i % labelStep === 0 || i === dates.length - 1);

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Cumulative Flow</h3>
        <div className="flex gap-1">
          {([7, 30, 90] as CfdWindow[]).map((w) => (
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
      <svg viewBox={`0 0 ${svgW} ${svgH}`} className="h-56 w-full overflow-visible">
        <line x1={padX} y1={padTop + plotH} x2={svgW - padX} y2={padTop + plotH} stroke="#d1d5db" />
        <line x1={padX} y1={padTop} x2={padX} y2={padTop + plotH} stroke="#d1d5db" />
        {[0, 0.5, 1].map((tick) => {
          const yTick = padTop + plotH - tick * plotH;
          return (
            <g key={tick}>
              <line x1={padX} x2={svgW - padX} y1={yTick} y2={yTick} stroke="#e5e7eb" />
              <text x={8} y={yTick + 4} className="fill-gray-500 text-[11px] dark:fill-gray-400">
                {Math.round(maxTotal * tick)}
              </text>
            </g>
          );
        })}
        {stackedPaths.map(({ status, polygonPoints, color }) => (
          <polygon
            key={status}
            points={polygonPoints}
            fill={color}
            fillOpacity={0.75}
            stroke={color}
            strokeWidth={0.5}
          >
            <title>{status}</title>
          </polygon>
        ))}
        {stackedPaths.map(({ status, topPoints, color }) => (
          <polyline
            key={`line-${status}`}
            points={topPoints}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        ))}
        {labelDates.map((date) => {
          const di = dates.indexOf(date);
          return (
            <text key={date} x={xOf(di, dates.length)} y={svgH - 8} textAnchor="middle" className="fill-gray-500 text-[11px] dark:fill-gray-400">
              {fmtDate(date)}
            </text>
          );
        })}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {statuses.map((status, si) => {
          const color = STATUS_COLORS[status] ?? fallbackColor(si);
          return (
            <div key={status} className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
              <span>{status}</span>
            </div>
          );
        })}
      </div>
    </div>
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

        <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <CumulativeFlowChart projectId={projectId} />
        </div>
      </div>
    </div>
  );
}
