import { useEffect, useMemo, useState } from "react";
import type { MilestoneResponse } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { ACCENT, BRAND } from "../lib/chartColors.js";

interface MilestonesOverviewProps {
  projectId: string;
  onMilestoneClick: (milestoneId: string) => void;
}

interface MilestoneBurndownPoint {
  date: string;
  remaining: number;
  opened: number;
  closed: number;
}

interface MilestoneSummary extends MilestoneResponse {
  totalIssues: number;
  openIssues: number;
  closedIssues: number;
  progressPercent: number;
  burndown: MilestoneBurndownPoint[];
}

function fmtDate(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function withAlpha(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function MiniBurndown({ points }: { points: MilestoneBurndownPoint[] }) {
  const width = 180;
  const height = 54;
  const pad = 4;
  const stats = useMemo(() => {
    const max = Math.max(...points.map((point) => point.remaining), 1);
    const n = points.length;
    const coords = points.map((point, index) => {
      const x = pad + (n <= 1 ? (width - pad * 2) / 2 : (index / (n - 1)) * (width - pad * 2));
      const y = pad + (height - pad * 2) - (point.remaining / max) * (height - pad * 2);
      return { ...point, x, y };
    });
    return { coords };
  }, [points]);

  if (points.length === 0) {
    return <div className="h-14 w-44 rounded border border-dashed border-black/[0.07] dark:border-white/10" />;
  }

  const path = stats.coords.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const area = `${path} L ${stats.coords.at(-1)?.x ?? pad} ${height - pad} L ${stats.coords[0]?.x ?? pad} ${height - pad} Z`;
  const first = points[0];
  const last = points.at(-1);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-14 w-44 overflow-visible" aria-label="Remaining open issues over time">
      <path d={area} fill={BRAND} fillOpacity={0.12} />
      <path d={path} fill="none" stroke={BRAND} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {stats.coords.map((point, index) => (
        <circle
          key={point.date}
          cx={point.x}
          cy={point.y}
          r={index === stats.coords.length - 1 ? 2.5 : 1.5}
          fill={index === stats.coords.length - 1 ? ACCENT : BRAND}
        >
          <title>{`${fmtDate(point.date)}: ${point.remaining} open`}</title>
        </circle>
      ))}
      {first && last && (
        <title>{`${fmtDate(first.date)} to ${fmtDate(last.date)}: ${first.remaining} -> ${last.remaining} open`}</title>
      )}
    </svg>
  );
}

export function MilestonesOverview({ projectId, onMilestoneClick }: MilestonesOverviewProps) {
  const [milestones, setMilestones] = useState<MilestoneSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<MilestoneSummary[]>(`/api/projects/${encodeURIComponent(projectId)}/milestones/summary?days=${days}`)
      .then((data) => {
        if (!cancelled) {
          setMilestones(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load milestones");
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [projectId, days, retryKey]);

  const totals = useMemo(() => {
    return milestones.reduce(
      (acc, milestone) => ({
        total: acc.total + milestone.totalIssues,
        open: acc.open + milestone.openIssues,
        closed: acc.closed + milestone.closedIssues,
      }),
      { total: 0, open: 0, closed: 0 },
    );
  }, [milestones]);

  return (
    <div className="flex-1 min-h-0 overflow-auto px-4 pb-6">
      <div className="mx-auto max-w-5xl space-y-4 pt-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Milestones</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Delivery state across active milestones.
            </p>
          </div>
          <div className="flex gap-1">
            {([7, 30, 90] as const).map((windowDays) => (
              <button
                key={windowDays}
                onClick={() => setDays(windowDays)}
                className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                  days === windowDays
                    ? "bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900"
                    : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                }`}
              >
                {windowDays}d
              </button>
            ))}
          </div>
        </div>

        {loading && (
          <div className="flex h-64 items-center justify-center text-sm text-gray-400 dark:text-gray-500">
            Loading milestones...
          </div>
        )}

        {!loading && error && (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-sm text-red-600 dark:text-red-400">
            <span>{error}</span>
            <button
              onClick={() => { setError(null); setRetryKey((key) => key + 1); }}
              className="rounded bg-red-100 px-3 py-1 text-xs text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && milestones.length > 0 && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Milestones</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{milestones.length}</div>
              </div>
              <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Open Issues</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{totals.open}</div>
              </div>
              <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Closed Issues</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{totals.closed}</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{totals.total} total assigned</div>
              </div>
            </div>

            <div className="space-y-2">
              {milestones.map((milestone) => (
                <button
                  key={milestone.id}
                  type="button"
                  onClick={() => onMilestoneClick(milestone.id)}
                  className="w-full rounded-md border border-gray-200 bg-white p-4 text-left transition-colors hover:border-brand-300 hover:bg-brand-50/40 focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-brand-700 dark:hover:bg-brand-950/20"
                >
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_180px] lg:items-center">
                    <div className="min-w-0 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{milestone.name}</h3>
                          {milestone.dueDate && (
                            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Due {fmtDate(milestone.dueDate)}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-gray-600 dark:text-gray-300">
                          <span>{milestone.openIssues} open</span>
                          <span>{milestone.closedIssues} closed</span>
                          <span className="font-semibold text-gray-900 dark:text-gray-100">{milestone.progressPercent}%</span>
                        </div>
                      </div>
                      <div
                        className="h-2 overflow-hidden rounded-full"
                        style={{ backgroundColor: withAlpha(ACCENT, 0.18) }}
                        aria-label={`${milestone.progressPercent}% closed`}
                      >
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ width: `${milestone.progressPercent}%`, backgroundColor: ACCENT }}
                        />
                      </div>
                    </div>
                    <div className="flex justify-start lg:justify-end">
                      <MiniBurndown points={milestone.burndown} />
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {!loading && !error && milestones.length === 0 && (
          <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-gray-200 text-sm text-gray-400 dark:border-gray-700 dark:text-gray-500">
            <svg className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 21V3l18 9-18 9z" />
            </svg>
            <span>No milestones yet</span>
          </div>
        )}
      </div>
    </div>
  );
}
