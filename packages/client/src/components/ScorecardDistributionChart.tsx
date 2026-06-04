import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { HEATMAP_SCALE, ACCENT } from "../lib/chartColors.js";

interface Bucket {
  range: string;
  count: number;
}

interface DistributionData {
  buckets: Bucket[];
  total: number;
}

const BUCKET_COLORS = [
  HEATMAP_SCALE[1],
  HEATMAP_SCALE[2],
  HEATMAP_SCALE[2],
  HEATMAP_SCALE[3],
  ACCENT,
] as const;

export function ScorecardDistributionChart({ projectId }: { projectId: string }) {
  const [data, setData] = useState<DistributionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<30 | 90 | 180>(90);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<DistributionData>(
      `/api/workspaces/scorecard-distribution?projectId=${encodeURIComponent(projectId)}&days=${days}`
    )
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err instanceof Error ? err.message : "Failed to load scorecard data"); setLoading(false); } });
    return () => { cancelled = true; };
  }, [projectId, days, retryKey]);

  const chart = useMemo(() => {
    if (!data || data.total === 0) return null;
    const maxCount = Math.max(...data.buckets.map((b) => b.count), 1);
    const avg = data.buckets.reduce((s, b, i) => {
      const midpoint = (i * 20 + 10);
      return s + b.count * midpoint;
    }, 0) / data.total;
    return { maxCount, avg: avg.toFixed(1) };
  }, [data]);

  const svgW = 480;
  const svgH = 200;
  const padX = 44;
  const padTop = 12;
  const padBottom = 32;
  const plotW = svgW - padX * 2;
  const plotH = svgH - padTop - padBottom;

  return (
    <div className="flex-1 overflow-auto px-4 pb-6">
      <div className="mx-auto max-w-3xl space-y-5 pt-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Score Distribution</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Workspace scorecard scores binned into 20-point buckets.
            </p>
          </div>
          <div className="flex gap-1">
            {([30, 90, 180] as const).map((w) => (
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
            Loading score distribution...
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
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Total Scored</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{data.total}</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">last {days} days</div>
              </div>
              <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Avg Score</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{chart.avg}</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">out of 100</div>
              </div>
              <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">High Quality</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
                  {data.buckets.slice(3).reduce((s, b) => s + b.count, 0)}
                </div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">scored 60+</div>
              </div>
            </div>

            <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <svg viewBox={`0 0 ${svgW} ${svgH}`} className="h-52 w-full overflow-visible">
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
                {data.buckets.map((bucket, i) => {
                  const n = data.buckets.length;
                  const slotW = plotW / n;
                  const barW = slotW * 0.65;
                  const cx = padX + (i + 0.5) * slotW;
                  const barH = chart.maxCount === 0 ? 0 : (bucket.count / chart.maxCount) * plotH;
                  const barY = padTop + plotH - barH;
                  const color = BUCKET_COLORS[i];
                  return (
                    <g key={bucket.range}>
                      {bucket.count > 0 && (
                        <rect
                          x={cx - barW / 2}
                          y={barY}
                          width={barW}
                          height={barH}
                          fill={color}
                          fillOpacity={0.9}
                          rx={2}
                        >
                          <title>{`${bucket.range}: ${bucket.count} workspace${bucket.count !== 1 ? "s" : ""}`}</title>
                        </rect>
                      )}
                      {bucket.count > 0 && (
                        <text x={cx} y={barY - 4} textAnchor="middle" className="fill-gray-600 text-[10px] dark:fill-gray-300">
                          {bucket.count}
                        </text>
                      )}
                      <text x={cx} y={svgH - 8} textAnchor="middle" className="fill-gray-500 text-[11px] dark:fill-gray-400">
                        {bucket.range}
                      </text>
                    </g>
                  );
                })}
              </svg>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-600 dark:text-gray-300">
                {data.buckets.map((bucket, i) => (
                  <span key={bucket.range} className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: BUCKET_COLORS[i] }} />
                    <span>{bucket.range}</span>
                  </span>
                ))}
              </div>
            </div>
          </>
        )}

        {!loading && !error && (!chart) && (
          <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-gray-200 text-sm text-gray-400 dark:border-gray-700 dark:text-gray-500">
            <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            <span>No scored workspaces in the last {days} days</span>
          </div>
        )}
      </div>
    </div>
  );
}
