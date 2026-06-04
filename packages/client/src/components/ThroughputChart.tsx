import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { STATUS_COLORS } from "../lib/chartColors.js";

interface ThroughputPoint {
  date: string;
  count: number;
}

interface ThroughputData {
  points: ThroughputPoint[];
}

function fmtDate(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const BAR_COLOR = STATUS_COLORS["Done"];

export function ThroughputChart({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ThroughputData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<14 | 30>(14);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<ThroughputData>(`/api/issues/throughput?projectId=${encodeURIComponent(projectId)}&days=${days}`)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err instanceof Error ? err.message : "Failed to load throughput data"); setLoading(false); } });
    return () => { cancelled = true; };
  }, [projectId, days]);

  const chart = useMemo(() => {
    if (!data || data.points.length === 0) return null;
    const maxCount = Math.max(...data.points.map((p) => p.count), 1);
    const total = data.points.reduce((s, p) => s + p.count, 0);
    const avg = data.points.length > 0 ? (total / data.points.length).toFixed(1) : "0";
    return { maxCount, total, avg };
  }, [data]);

  const svgW = 760;
  const svgH = 220;
  const padX = 44;
  const padTop = 12;
  const padBottom = 32;
  const plotW = svgW - padX * 2;
  const plotH = svgH - padTop - padBottom;

  return (
    <div className="flex-1 overflow-auto px-4 pb-6">
      <div className="mx-auto max-w-4xl space-y-5 pt-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Throughput</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Issues moved to Done per calendar day.
            </p>
          </div>
          <div className="flex gap-1">
            {([14, 30] as const).map((w) => (
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
              onClick={() => { setLoading(true); setError(null); }}
              className="rounded bg-red-100 px-3 py-1 text-xs text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && chart && data && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Total Done</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{chart.total}</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">last {days} days</div>
              </div>
              <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Daily Avg</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{chart.avg}</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">issues / day</div>
              </div>
              <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Best Day</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{chart.maxCount}</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">issues completed</div>
              </div>
            </div>

            <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <svg viewBox={`0 0 ${svgW} ${svgH}`} className="h-56 w-full overflow-visible">
                {/* axes */}
                <line x1={padX} y1={padTop + plotH} x2={svgW - padX} y2={padTop + plotH} stroke="#d1d5db" />
                <line x1={padX} y1={padTop} x2={padX} y2={padTop + plotH} stroke="#d1d5db" />
                {/* y-axis ticks */}
                {[0, 0.5, 1].map((tick) => {
                  const yTick = padTop + plotH - tick * plotH;
                  return (
                    <g key={tick}>
                      <line x1={padX} x2={svgW - padX} y1={yTick} y2={yTick} stroke="#e5e7eb" />
                      <text x={8} y={yTick + 4} className="fill-gray-500 text-[11px] dark:fill-gray-400">
                        {Math.round(chart.maxCount * tick)}
                      </text>
                    </g>
                  );
                })}
                {/* bars */}
                {data.points.map((pt, i) => {
                  const n = data.points.length;
                  const slotW = plotW / n;
                  const barW = Math.max(slotW * 0.6, 2);
                  const cx = padX + (i + 0.5) * slotW;
                  const barH = chart.maxCount === 0 ? 0 : (pt.count / chart.maxCount) * plotH;
                  const barY = padTop + plotH - barH;
                  return (
                    <g key={pt.date}>
                      {pt.count > 0 && (
                        <rect
                          x={cx - barW / 2}
                          y={barY}
                          width={barW}
                          height={barH}
                          fill={BAR_COLOR}
                          fillOpacity={0.85}
                          rx={2}
                        >
                          <title>{`${fmtDate(pt.date)}: ${pt.count} issue${pt.count !== 1 ? "s" : ""} completed`}</title>
                        </rect>
                      )}
                      {/* x-axis label: show every 2nd label when days=14, every 4th for 30 */}
                      {(days === 14 ? i % 2 === 0 : i % 4 === 0) || i === data.points.length - 1 ? (
                        <text x={cx} y={svgH - 8} textAnchor="middle" className="fill-gray-500 text-[11px] dark:fill-gray-400">
                          {fmtDate(pt.date)}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
              <div className="mt-2 flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: BAR_COLOR }} />
                <span>Done</span>
              </div>
            </div>
          </>
        )}

        {!loading && !error && (!chart || (data && data.points.every((p) => p.count === 0))) && (
          <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-gray-200 text-sm text-gray-400 dark:border-gray-700 dark:text-gray-500">
            <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h4v7H3zM10 8h4v11h-4zM17 4h4v15h-4zM3 19h18" />
            </svg>
            <span>No issues completed in the last {days} days</span>
          </div>
        )}
      </div>
    </div>
  );
}
