import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { BRAND, ACCENT, SEMANTIC } from "../lib/chartColors.js";

interface CostPoint {
  date: string;
  costs: Record<string, number>;
}

interface CostData {
  series: string[];
  points: CostPoint[];
}

/**
 * Stable color per provider key, drawn from the chartColors palette. Intentionally
 * matches ProviderMixChart so the same provider reads the same hue in both views.
 */
const PROVIDER_COLORS: Record<string, string> = {
  claude:  BRAND,            // terracotta
  codex:   ACCENT,           // sage
  copilot: SEMANTIC.created, // muted slate-teal
  unknown: "#b3a89a",        // warm neutral gray
};

function providerColor(key: string): string {
  return PROVIDER_COLORS[key.toLowerCase()] ?? "#8a8175";
}

function fmtDate(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Currency with adaptive precision: enough decimals to surface sub-cent spend. */
function fmtCost(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function EmptyState({ days }: { days: number }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-gray-200 text-sm text-gray-400 dark:border-gray-700 dark:text-gray-500">
      <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13l4-3 4 2 4-5 4 3M3 19h18" />
      </svg>
      <span>No recorded token cost in the last {days} days</span>
    </div>
  );
}

export function ProviderCostOverTimeChart({ projectId }: { projectId: string }) {
  const [data, setData] = useState<CostData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<CostData>(
      `/api/workspaces/cost-over-time?projectId=${encodeURIComponent(projectId)}&days=${days}`
    )
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err instanceof Error ? err.message : "Failed to load cost data"); setLoading(false); } });
    return () => { cancelled = true; };
  }, [projectId, days, retryKey]);

  const chart = useMemo(() => {
    if (!data || data.points.length === 0 || data.series.length === 0) return null;
    const totals: Record<string, number> = {};
    for (const s of data.series) totals[s] = 0;
    let grandTotal = 0;
    for (const pt of data.points) {
      for (const s of data.series) {
        totals[s] += pt.costs[s] ?? 0;
        grandTotal += pt.costs[s] ?? 0;
      }
    }
    // Nothing meaningful to plot when no cost was recorded (e.g. only uncosted providers).
    if (grandTotal === 0) return null;
    const maxStack = Math.max(
      ...data.points.map((pt) => data.series.reduce((s, k) => s + (pt.costs[k] ?? 0), 0)),
      0,
    );
    return { totals, grandTotal, maxStack };
  }, [data]);

  const svgW = 760;
  const svgH = 220;
  const padX = 52;
  const padTop = 12;
  const padBottom = 32;
  const plotW = svgW - padX * 2;
  const plotH = svgH - padTop - padBottom;

  return (
    <div className="flex-1 overflow-auto px-4 pb-6">
      <div className="mx-auto max-w-4xl space-y-5 pt-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Provider Cost Over Time</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Estimated token cost per day, grouped by agent provider.
            </p>
          </div>
          <div className="flex gap-1">
            {([7, 30, 90] as const).map((w) => (
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
            Loading cost data...
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

        {!loading && !error && chart && data && (
          <>
            {/* Summary stat tiles */}
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(data.series.length + 1, 4)}, minmax(0, 1fr))` }}>
              <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Total Cost</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{fmtCost(chart.grandTotal)}</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">last {days} days</div>
              </div>
              {data.series.map((s) => (
                <div key={s} className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                  <div className="flex items-center gap-1.5 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                    <span className="h-2.5 w-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: providerColor(s) }} />
                    {s}
                  </div>
                  <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{fmtCost(chart.totals[s])}</div>
                  <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {chart.grandTotal > 0 ? `${Math.round((chart.totals[s] / chart.grandTotal) * 100)}%` : "0%"}
                  </div>
                </div>
              ))}
            </div>

            {/* Stacked bar chart */}
            <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <svg viewBox={`0 0 ${svgW} ${svgH}`} className="h-56 w-full overflow-visible">
                {/* axes */}
                <line x1={padX} y1={padTop + plotH} x2={svgW - padX} y2={padTop + plotH} stroke="#d1d5db" />
                <line x1={padX} y1={padTop} x2={padX} y2={padTop + plotH} stroke="#d1d5db" />
                {/* y-axis gridlines */}
                {[0, 0.5, 1].map((tick) => {
                  const yTick = padTop + plotH - tick * plotH;
                  return (
                    <g key={tick}>
                      <line x1={padX} x2={svgW - padX} y1={yTick} y2={yTick} stroke="#e5e7eb" />
                      <text x={padX - 6} y={yTick + 4} textAnchor="end" className="fill-gray-500 text-[11px] dark:fill-gray-400">
                        {fmtCost(chart.maxStack * tick)}
                      </text>
                    </g>
                  );
                })}
                {/* stacked bars */}
                {data.points.map((pt, i) => {
                  const n = data.points.length;
                  const slotW = plotW / n;
                  const barW = Math.max(slotW * 0.6, 2);
                  const cx = padX + (i + 0.5) * slotW;
                  const totalDay = data.series.reduce((s, k) => s + (pt.costs[k] ?? 0), 0);

                  let yOffset = padTop + plotH;
                  const segments = data.series.map((key) => {
                    const cost = pt.costs[key] ?? 0;
                    const barH = chart.maxStack === 0 ? 0 : (cost / chart.maxStack) * plotH;
                    yOffset -= barH;
                    return { key, cost, barH, y: yOffset };
                  });

                  return (
                    <g key={pt.date}>
                      {segments.map(({ key, cost, barH, y }) =>
                        cost > 0 ? (
                          <rect
                            key={key}
                            x={cx - barW / 2}
                            y={y}
                            width={barW}
                            height={barH}
                            fill={providerColor(key)}
                            fillOpacity={0.85}
                            rx={1}
                          >
                            <title>{`${fmtDate(pt.date)} — ${key}: ${fmtCost(cost)}`}</title>
                          </rect>
                        ) : null
                      )}
                      {(days === 7 ? true : days === 30 ? i % 4 === 0 : i % 10 === 0) || i === data.points.length - 1 ? (
                        <text x={cx} y={svgH - 8} textAnchor="middle" className="fill-gray-500 text-[11px] dark:fill-gray-400">
                          {fmtDate(pt.date)}
                        </text>
                      ) : null}
                      {totalDay > 0 && (
                        <text
                          x={cx}
                          y={padTop + plotH - (totalDay / chart.maxStack) * plotH - 3}
                          textAnchor="middle"
                          className="fill-gray-500 text-[9px] dark:fill-gray-400"
                        >
                          {fmtCost(totalDay)}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {data.series.map((s) => (
                  <div key={s} className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: providerColor(s) }} />
                    <span className="capitalize">{s}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {!loading && !error && !chart && <EmptyState days={days} />}
      </div>
    </div>
  );
}
