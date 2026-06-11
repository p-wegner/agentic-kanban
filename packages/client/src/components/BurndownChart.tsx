import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { BRAND } from "../lib/chartColors.js";

interface BurndownBucket {
  date: string;
  remaining: number;
  opened: number;
  closed: number;
}

interface BurndownData {
  buckets: BurndownBucket[];
  startCount: number;
  endCount: number;
  totalClosed: number;
  totalOpened: number;
}

/** Ideal target trend line color — a muted gray so the actual line reads as primary. */
const IDEAL_COLOR = "#9ca3af";

function fmtDate(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function BurndownChart({ projectId }: { projectId: string }) {
  const [data, setData] = useState<BurndownData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<BurndownData>(`/api/issues/burndown?projectId=${encodeURIComponent(projectId)}&days=${days}`)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err instanceof Error ? err.message : "Failed to load burndown data"); setLoading(false); } });
    return () => { cancelled = true; };
  }, [projectId, days, retryKey]);

  const stats = useMemo(() => {
    if (!data || data.buckets.length === 0) return null;
    // Show the empty state only when every day has zero remaining — projects that
    // had no open issues at window-start but accumulated opens during the window
    // should still render the chart (growth from zero is valid burndown data).
    if (data.buckets.every((b) => b.remaining === 0)) return null;
    const maxRemaining = Math.max(...data.buckets.map((b) => b.remaining), 1);
    return { maxRemaining };
  }, [data]);

  const svgW = 760;
  const svgH = 220;
  const padX = 52;
  const padTop = 12;
  const padBottom = 32;
  const plotW = svgW - padX * 2;
  const plotH = svgH - padTop - padBottom;

  // Map day index to x. Day 0 sits at the left edge, the last day at the right edge so the
  // ideal trend line spans the full width.
  function xPos(i: number, n: number): number {
    return padX + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  }
  function yVal(count: number, max: number): number {
    return padTop + plotH - (count / max) * plotH;
  }

  return (
    <div className="flex-1 overflow-auto px-4 pb-6">
      <div className="mx-auto max-w-4xl space-y-5 pt-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Burndown</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Remaining open issues (not Done/Cancelled) per day vs. the ideal trend to zero.
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
            Loading burndown data...
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
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Open at Start</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{data.startCount}</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{days} days ago</div>
              </div>
              <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Open Now</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{data.endCount}</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {data.endCount <= data.startCount
                    ? `${data.startCount - data.endCount} cleared`
                    : `${data.endCount - data.startCount} net added`}
                </div>
              </div>
              <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Closed</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{data.totalClosed}</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {(data.totalClosed / days).toFixed(1)}/day · {data.totalOpened} opened
                </div>
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
                      <text x={padX - 6} y={yTick + 4} textAnchor="end" className="fill-gray-500 text-[11px] dark:fill-gray-400">
                        {Math.round(stats.maxRemaining * tick)}
                      </text>
                    </g>
                  );
                })}
                {(() => {
                  const n = data.buckets.length;
                  const max = stats.maxRemaining;
                  const px = (i: number) => xPos(i, n);
                  const py = (c: number) => yVal(c, max);
                  // ideal target trend: start count down to zero over the window
                  const ideal = `${px(0)},${py(data.startCount)} ${px(n - 1)},${py(0)}`;
                  return (
                    <polyline
                      points={ideal}
                      fill="none"
                      stroke={IDEAL_COLOR}
                      strokeWidth={1.5}
                      strokeDasharray="5 4"
                      strokeOpacity={0.8}
                    />
                  );
                })()}
                {/* remaining area */}
                {(() => {
                  const n = data.buckets.length;
                  const max = stats.maxRemaining;
                  const pts = data.buckets.map((b, i) => `${xPos(i, n)},${yVal(b.remaining, max)}`);
                  return (
                    <path
                      d={`M ${pts[0]} L ${pts.slice(1).join(" L ")} L ${xPos(n - 1, n)},${padTop + plotH} L ${xPos(0, n)},${padTop + plotH} Z`}
                      fill={BRAND}
                      fillOpacity={0.12}
                    />
                  );
                })()}
                {/* remaining line */}
                {(() => {
                  const n = data.buckets.length;
                  const max = stats.maxRemaining;
                  const pts = data.buckets.map((b, i) => `${xPos(i, n)},${yVal(b.remaining, max)}`);
                  return (
                    <polyline points={pts.join(" ")} fill="none" stroke={BRAND} strokeWidth={2} />
                  );
                })()}
                {/* dots + x labels */}
                {data.buckets.map((b, i) => {
                  const n = data.buckets.length;
                  const x = xPos(i, n);
                  const y = yVal(b.remaining, stats.maxRemaining);
                  const showLabel = days === 7 ? true : days === 30 ? i % 4 === 0 || i === n - 1 : i % 10 === 0 || i === n - 1;
                  const delta = b.closed - b.opened;
                  return (
                    <g key={b.date}>
                      <circle cx={x} cy={y} r={2.5} fill={BRAND}>
                        <title>
                          {`${fmtDate(b.date)}: ${b.remaining} open` +
                            (b.opened > 0 || b.closed > 0
                              ? ` (+${b.opened} opened, −${b.closed} closed${delta !== 0 ? `, ${delta > 0 ? `−${delta}` : `+${-delta}`} net` : ""})`
                              : "")}
                        </title>
                      </circle>
                      {showLabel && (
                        <text x={x} y={svgH - 8} textAnchor="middle" className="fill-gray-500 text-[11px] dark:fill-gray-400">
                          {fmtDate(b.date)}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
              <div className="mt-2 flex items-center gap-3 text-xs text-gray-600 dark:text-gray-300">
                <span className="flex items-center gap-1.5">
                  <span className="block h-0.5 w-4 rounded" style={{ backgroundColor: BRAND }} />
                  Remaining open
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="block h-0.5 w-4 rounded border-t border-dashed" style={{ borderColor: IDEAL_COLOR }} />
                  Ideal target
                </span>
              </div>
            </div>
          </>
        )}

        {!loading && !error && !stats && (
          <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-gray-200 text-sm text-gray-400 dark:border-gray-700 dark:text-gray-500">
            <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 13l4-3 4 2 4-5 4 3" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 19h18" />
            </svg>
            <span>No open issues in the last {days} days</span>
          </div>
        )}
      </div>
    </div>
  );
}
