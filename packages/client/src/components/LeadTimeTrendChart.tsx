import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { ACCENT, STATUS_COLORS } from "../lib/chartColors.js";

interface LeadTimeBucket {
  date: string;
  count: number;
  medianMs: number | null;
  p90Ms: number | null;
}

interface LeadTimeData {
  buckets: LeadTimeBucket[];
}

function fmtDate(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function msToHours(ms: number): number {
  return ms / (1000 * 60 * 60);
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return "—";
  const h = msToHours(ms);
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  return d < 10 ? `${d.toFixed(1)}d` : `${Math.round(d)}d`;
}

const MEDIAN_COLOR = STATUS_COLORS["Done"];
const P90_COLOR = ACCENT;

export function LeadTimeTrendChart({ projectId }: { projectId: string }) {
  const [data, setData] = useState<LeadTimeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<LeadTimeData>(`/api/issues/lead-time?projectId=${encodeURIComponent(projectId)}&days=${days}`)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err instanceof Error ? err.message : "Failed to load lead time data"); setLoading(false); } });
    return () => { cancelled = true; };
  }, [projectId, days, retryKey]);

  const stats = useMemo(() => {
    if (!data) return null;
    const filled = data.buckets.filter((b) => b.count > 0 && b.medianMs !== null);
    if (filled.length === 0) return null;
    const total = data.buckets.reduce((s, b) => s + b.count, 0);
    const medians = filled.map((b) => b.medianMs as number);
    const p90s = filled.map((b) => b.p90Ms as number).filter((v) => v !== null);
    const overallMedian = medians.reduce((s, v) => s + v, 0) / medians.length;
    const maxP90 = Math.max(...p90s, 0);
    const maxVal = Math.max(...data.buckets.map((b) => b.p90Ms ?? b.medianMs ?? 0), 1);
    return { total, overallMedian, maxP90, maxVal };
  }, [data]);

  const svgW = 760;
  const svgH = 220;
  const padX = 52;
  const padTop = 12;
  const padBottom = 32;
  const plotW = svgW - padX * 2;
  const plotH = svgH - padTop - padBottom;

  function yPos(ms: number | null): number | null {
    if (ms === null || !stats) return null;
    return padTop + plotH - (ms / stats.maxVal) * plotH;
  }

  return (
    <div className="flex-1 overflow-auto px-4 pb-6">
      <div className="mx-auto max-w-4xl space-y-5 pt-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Lead Time Trend</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Time from issue creation to Done — median and p90 per day.
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
            Loading lead time data...
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
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Issues Completed</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{stats.total}</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">last {days} days</div>
              </div>
              <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Avg Median Lead Time</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{fmtDuration(stats.overallMedian)}</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">creation → Done</div>
              </div>
              <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Peak p90</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{fmtDuration(stats.maxP90)}</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">worst tail latency</div>
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
                  const label = fmtDuration(stats.maxVal * tick);
                  return (
                    <g key={tick}>
                      <line x1={padX} x2={svgW - padX} y1={yTick} y2={yTick} stroke="#e5e7eb" />
                      <text x={padX - 6} y={yTick + 4} textAnchor="end" className="fill-gray-500 text-[11px] dark:fill-gray-400">
                        {label}
                      </text>
                    </g>
                  );
                })}
                {/* p90 area */}
                {(() => {
                  const pts = data.buckets
                    .map((b, i) => {
                      const x = padX + (i + 0.5) * (plotW / data.buckets.length);
                      const y = yPos(b.p90Ms);
                      return y !== null ? `${x},${y}` : null;
                    })
                    .filter(Boolean) as string[];
                  if (pts.length < 2) return null;
                  const first = pts[0].split(",");
                  const last = pts[pts.length - 1].split(",");
                  const areaPath = `M ${first[0]} ${padTop + plotH} L ${pts.join(" L ")} L ${last[0]} ${padTop + plotH} Z`;
                  return (
                    <path d={areaPath} fill={P90_COLOR} fillOpacity={0.12} />
                  );
                })()}
                {/* p90 line */}
                {(() => {
                  const pts = data.buckets
                    .map((b, i) => {
                      const x = padX + (i + 0.5) * (plotW / data.buckets.length);
                      const y = yPos(b.p90Ms);
                      return y !== null ? `${x},${y}` : null;
                    })
                    .filter(Boolean) as string[];
                  if (pts.length < 2) return null;
                  return (
                    <polyline
                      points={pts.join(" ")}
                      fill="none"
                      stroke={P90_COLOR}
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      strokeOpacity={0.7}
                    />
                  );
                })()}
                {/* median line */}
                {(() => {
                  const pts = data.buckets
                    .map((b, i) => {
                      const x = padX + (i + 0.5) * (plotW / data.buckets.length);
                      const y = yPos(b.medianMs);
                      return y !== null ? `${x},${y}` : null;
                    })
                    .filter(Boolean) as string[];
                  if (pts.length < 2) return null;
                  return (
                    <polyline
                      points={pts.join(" ")}
                      fill="none"
                      stroke={MEDIAN_COLOR}
                      strokeWidth={2}
                    />
                  );
                })()}
                {/* dots + x labels */}
                {data.buckets.map((b, i) => {
                  const n = data.buckets.length;
                  const x = padX + (i + 0.5) * (plotW / n);
                  const showLabel = days === 7 ? true : days === 30 ? i % 4 === 0 || i === n - 1 : i % 10 === 0 || i === n - 1;
                  const medY = yPos(b.medianMs);
                  const p90Y = yPos(b.p90Ms);
                  return (
                    <g key={b.date}>
                      {medY !== null && (
                        <circle cx={x} cy={medY} r={2.5} fill={MEDIAN_COLOR}>
                          <title>{`${fmtDate(b.date)}: median ${fmtDuration(b.medianMs)} (${b.count} issue${b.count !== 1 ? "s" : ""})`}</title>
                        </circle>
                      )}
                      {p90Y !== null && (
                        <circle cx={x} cy={p90Y} r={2} fill={P90_COLOR} fillOpacity={0.8}>
                          <title>{`${fmtDate(b.date)}: p90 ${fmtDuration(b.p90Ms)}`}</title>
                        </circle>
                      )}
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
                  <span className="block h-0.5 w-4 rounded" style={{ backgroundColor: MEDIAN_COLOR }} />
                  Median
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="block h-0.5 w-4 rounded border-t border-dashed" style={{ borderColor: P90_COLOR }} />
                  p90
                </span>
              </div>
            </div>
          </>
        )}

        {!loading && !error && !stats && (
          <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-gray-200 text-sm text-gray-400 dark:border-gray-700 dark:text-gray-500">
            <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>No completed issues in the last {days} days</span>
          </div>
        )}
      </div>
    </div>
  );
}
