import { useEffect, useMemo, useState } from "react";
import type { IssueWithStatus, ProjectStatsResponse, StatusWithIssues } from "@agentic-kanban/shared";
import { STATUS_COLORS, PRIORITY_META, TYPE_COLORS, BRAND, ACCENT, HEATMAP_SCALE } from "../lib/chartColors";
import { apiFetch } from "../lib/api.js";

interface MetricsViewProps {
  columns: StatusWithIssues[];
  projectId: string | null;
  onIssueClick: (issue: IssueWithStatus) => void;
}

const TYPE_META: Array<{ key: string; label: string; color: string }> = [
  { key: "task",    label: "Task",    color: TYPE_COLORS.task },
  { key: "feature", label: "Feature", color: TYPE_COLORS.feature },
  { key: "bug",     label: "Bug",     color: TYPE_COLORS.bug },
  { key: "chore",   label: "Chore",   color: TYPE_COLORS.chore },
];

const HEATMAP_WEEKS = 16;
const DAYS_OF_WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function DonutChart({
  segments,
  size = 140,
  strokeWidth = 26,
}: {
  segments: { label: string; count: number; color: string }[];
  size?: number;
  strokeWidth?: number;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const cx = size / 2;
  const cy = size / 2;
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  const total = segments.reduce((s, seg) => s + seg.count, 0);

  if (total === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">
        No issues yet
      </div>
    );
  }

  let cumulativeOffset = 0;
  const arcs = segments
    .filter((s) => s.count > 0)
    .map((seg) => {
      const fraction = seg.count / total;
      const dashLen = fraction * circumference;
      const dashOffset = -(cumulativeOffset * circumference - circumference / 4);
      cumulativeOffset += fraction;
      return { ...seg, dashLen, dashOffset };
    });

  const hoveredSeg = hovered !== null ? arcs[hovered] : null;

  return (
    <div className="flex items-center gap-5">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size}>
          {arcs.map((arc, i) => (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={arc.color}
              strokeWidth={hovered === i ? strokeWidth + 4 : strokeWidth}
              strokeDasharray={`${arc.dashLen} ${circumference}`}
              strokeDashoffset={arc.dashOffset}
              strokeLinecap="butt"
              className="transition-all duration-150 cursor-pointer"
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            />
          ))}
          <text
            x={cx}
            y={cy - 8}
            textAnchor="middle"
            fontSize="24"
            fontWeight="700"
            fill={hoveredSeg ? hoveredSeg.color : "currentColor"}
            className="transition-colors duration-150"
          >
            {hoveredSeg ? hoveredSeg.count : total}
          </text>
          <text
            x={cx}
            y={cy + 10}
            textAnchor="middle"
            fontSize="11"
            fill="#9ca3af"
          >
            {hoveredSeg ? hoveredSeg.label : "total"}
          </text>
        </svg>
      </div>
      <div className="flex flex-col gap-1.5">
        {arcs.map((arc, i) => (
          <div
            key={i}
            className="flex items-center gap-2 cursor-default"
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          >
            <span
              className="w-2.5 h-2.5 rounded-sm shrink-0 transition-transform duration-150"
              style={{
                backgroundColor: arc.color,
                transform: hovered === i ? "scale(1.3)" : "scale(1)",
              }}
            />
            <span className="text-xs text-gray-600 dark:text-gray-400 flex-1 whitespace-nowrap">
              {arc.label}
            </span>
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-200 ml-2">
              {arc.count}
            </span>
            <span className="text-xs text-gray-400 dark:text-gray-500 w-8 text-right">
              {Math.round((arc.count / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HorizontalBars({
  items,
}: {
  items: { key?: string; label: string; count: number; color: string; lightBg: string; darkBg: string }[];
}) {
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <div className="flex flex-col gap-2.5 w-full">
      {items.map((item) => (
        <div key={item.key ?? item.label} className="flex items-center gap-3">
          <span className="text-xs text-gray-500 dark:text-gray-400 w-16 shrink-0 capitalize">
            {item.label}
          </span>
          <div className="flex-1 h-5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${(item.count / max) * 100}%`,
                backgroundColor: item.color,
                minWidth: item.count > 0 ? 4 : 0,
              }}
            />
          </div>
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-200 w-6 text-right shrink-0">
            {item.count}
          </span>
        </div>
      ))}
    </div>
  );
}

function VerticalBars({ items }: { items: { label: string; count: number; color: string }[] }) {
  const max = Math.max(...items.map((i) => i.count), 1);
  const barH = 80;
  return (
    <div className="flex items-end justify-around gap-2 w-full" style={{ height: barH + 36 }}>
      {items.map((item) => {
        const h = Math.max((item.count / max) * barH, item.count > 0 ? 4 : 0);
        return (
          <div key={item.label} className="flex flex-col items-center gap-1 flex-1">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">
              {item.count}
            </span>
            <div className="w-full rounded-t-md transition-all duration-500" style={{ height: h, backgroundColor: item.color }} />
            <span className="text-[10px] text-gray-500 dark:text-gray-400 text-center">{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function CodeGrowthChart({ weeks }: { weeks: ProjectStatsResponse["history"]["weeks"] }) {
  const maxAbs = Math.max(...weeks.map((week) => Math.abs(week.net)), 1);
  return (
    <div className="flex items-end gap-2 h-32">
      {weeks.map((week) => {
        const height = Math.max((Math.abs(week.net) / maxAbs) * 86, week.net !== 0 ? 4 : 2);
        const isPositive = week.net >= 0;
        return (
          <div key={week.week} className="flex flex-col items-center justify-end flex-1 min-w-0 gap-1">
            <div className="text-[10px] text-gray-500 dark:text-gray-400 tabular-nums">
              {week.commits}
            </div>
            <div
              className="w-full rounded-t-sm"
              title={`${week.net >= 0 ? "+" : ""}${week.net} LOC net, ${week.commits} commits since ${week.week}`}
              style={{
                height,
                backgroundColor: isPositive ? BRAND : "#ef4444",
                opacity: week.net === 0 ? 0.28 : 0.85,
              }}
            />
            <div className="text-[10px] text-gray-400 dark:text-gray-500">
              {new Date(`${week.week}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LocSplit({ stats }: { stats: ProjectStatsResponse["codeMetrics"] }) {
  const prodPct = stats.totalLoc > 0 ? (stats.productionLoc / stats.totalLoc) * 100 : 0;
  const testPct = stats.totalLoc > 0 ? (stats.testLoc / stats.totalLoc) * 100 : 0;
  return (
    <div className="space-y-3">
      <div className="h-4 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden flex">
        <div
          className="h-full"
          style={{ width: `${prodPct}%`, backgroundColor: BRAND }}
          title={`${formatCount(stats.productionLoc)} production LOC`}
        />
        <div
          className="h-full"
          style={{ width: `${testPct}%`, backgroundColor: ACCENT }}
          title={`${formatCount(stats.testLoc)} test LOC`}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400">Production</p>
          <p className="text-xl font-bold text-gray-800 dark:text-gray-100">{formatCount(stats.productionLoc)}</p>
          <p className="text-[10px] text-gray-400 dark:text-gray-500">{stats.productionFiles} files</p>
        </div>
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400">Tests</p>
          <p className="text-xl font-bold text-gray-800 dark:text-gray-100">{formatCount(stats.testLoc)}</p>
          <p className="text-[10px] text-gray-400 dark:text-gray-500">{stats.testFiles} files / {stats.testRatio}% LOC</p>
        </div>
      </div>
    </div>
  );
}

function ActivityHeatmap({ issues }: { issues: IssueWithStatus[] }) {
  const { cells, maxCount, weeks } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Build a map of date → count
    const countMap: Record<string, number> = {};
    for (const issue of issues) {
      const d = new Date(issue.createdAt);
      d.setHours(0, 0, 0, 0);
      const key = d.toISOString().slice(0, 10);
      countMap[key] = (countMap[key] ?? 0) + 1;
    }

    // Start from 16 weeks ago, aligned to Sunday
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - HEATMAP_WEEKS * 7 + 1);
    // align to Sunday
    startDate.setDate(startDate.getDate() - startDate.getDay());

    const weeksArr: Array<Array<{ date: Date; count: number; key: string }>> = [];
    let current = new Date(startDate);
    let max = 0;

    for (let w = 0; w < HEATMAP_WEEKS; w++) {
      const week: Array<{ date: Date; count: number; key: string }> = [];
      for (let d = 0; d < 7; d++) {
        const key = current.toISOString().slice(0, 10);
        const count = countMap[key] ?? 0;
        if (count > max) max = count;
        week.push({ date: new Date(current), count, key });
        current.setDate(current.getDate() + 1);
      }
      weeksArr.push(week);
    }

    return { cells: weeksArr, maxCount: max, weeks: weeksArr };
  }, [issues]);

  function cellColor(count: number): string {
    if (count === 0) return undefined as unknown as string;
    const intensity = Math.min(1, count / Math.max(maxCount, 1));
    if (intensity < 0.25) return HEATMAP_SCALE[1];
    if (intensity < 0.5)  return HEATMAP_SCALE[2];
    if (intensity < 0.75) return HEATMAP_SCALE[3];
    return HEATMAP_SCALE[4];
  }

  // Month labels
  const monthLabels = useMemo(() => {
    const labels: Array<{ label: string; weekIdx: number }> = [];
    let lastMonth = -1;
    weeks.forEach((week, wi) => {
      const month = week[0].date.getMonth();
      if (month !== lastMonth) {
        labels.push({
          label: week[0].date.toLocaleDateString('en-US', { month: "short" }),
          weekIdx: wi,
        });
        lastMonth = month;
      }
    });
    return labels;
  }, [weeks]);

  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);

  const CELL = 12;
  const GAP = 2;
  const STEP = CELL + GAP;

  return (
    <div className="relative">
      {/* Month labels */}
      <div className="flex mb-0.5 ml-8" style={{ gap: 0 }}>
        {weeks.map((_, wi) => {
          const label = monthLabels.find((m) => m.weekIdx === wi);
          return (
            <div key={wi} style={{ width: STEP }} className="relative">
              {label && (
                <span className="absolute text-[10px] text-gray-400 dark:text-gray-500 whitespace-nowrap">
                  {label.label}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex gap-1">
        {/* Day labels */}
        <div className="flex flex-col justify-around" style={{ gap: GAP, paddingTop: 2 }}>
          {DAYS_OF_WEEK.map((day, i) =>
            i % 2 === 1 ? (
              <span key={day} className="text-[10px] text-gray-400 dark:text-gray-500 w-6 text-right leading-none" style={{ height: CELL }}>
                {day}
              </span>
            ) : (
              <div key={day} style={{ height: CELL }} />
            )
          )}
        </div>

        {/* Grid */}
        <div className="flex" style={{ gap: GAP }}>
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col" style={{ gap: GAP }}>
              {week.map((cell) => {
                const color = cellColor(cell.count);
                const isToday = cell.key === new Date().toISOString().slice(0, 10);
                return (
                  <div
                    key={cell.key}
                    style={{
                      width: CELL,
                      height: CELL,
                      backgroundColor: color ?? undefined,
                      outline: isToday ? `2px solid ${BRAND}` : undefined,
                      outlineOffset: "1px",
                    }}
                    className={`rounded-sm cursor-default transition-opacity hover:opacity-80 ${!color ? "bg-gray-100 dark:bg-gray-800" : ""}`}
                    onMouseEnter={(e) => {
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      const d = cell.date.toLocaleDateString('en-US', { month: "short", day: "numeric", year: "numeric" });
                      setTooltip({
                        text: `${cell.count} issue${cell.count !== 1 ? "s" : ""} / ${d}`,
                        x: rect.left + rect.width / 2,
                        y: rect.top,
                      });
                    }}
                    onMouseLeave={() => setTooltip(null)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-1.5 mt-2 ml-8">
        <span className="text-[10px] text-gray-400 dark:text-gray-500">Less</span>
        {HEATMAP_SCALE.map((c) => (
          <div key={c} className="rounded-sm" style={{ width: CELL, height: CELL, backgroundColor: c }} />
        ))}
        <span className="text-[10px] text-gray-400 dark:text-gray-500">More</span>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none bg-gray-900 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded shadow-lg whitespace-nowrap"
          style={{ left: tooltip.x, top: tooltip.y - 8, transform: "translate(-50%, -100%)" }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 flex flex-col gap-0.5">
      <span className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide font-medium">{label}</span>
      <span className="text-2xl font-bold" style={color ? { color } : undefined}>
        {value}
      </span>
      {sub && <span className="text-xs text-gray-400 dark:text-gray-500">{sub}</span>}
    </div>
  );
}

export function MetricsView({ columns, projectId, onIssueClick }: MetricsViewProps) {
  const [projectStats, setProjectStats] = useState<ProjectStatsResponse | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const allIssues = useMemo(() => columns.flatMap((c) => c.issues), [columns]);
  const statsRefreshKey = useMemo(
    () => allIssues.reduce((latest, issue) => issue.updatedAt > latest ? issue.updatedAt : latest, ""),
    [allIssues],
  );

  useEffect(() => {
    let cancelled = false;
    if (!projectId) {
      setProjectStats(null);
      setStatsError(null);
      return;
    }

    apiFetch<ProjectStatsResponse>(`/api/projects/${projectId}/stats`)
      .then((stats) => {
        if (!cancelled) {
          setProjectStats(stats);
          setStatsError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setProjectStats(null);
          setStatsError(err instanceof Error ? err.message : "Failed to load project metrics");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, statsRefreshKey]);

  const statusSegments = useMemo(() =>
    columns.map((col) => ({
      label: col.name,
      count: col.issues.length,
      color: STATUS_COLORS[col.name] ?? "#94a3b8",
    })).filter((s) => s.count > 0),
    [columns]
  );

  const priorityCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const issue of allIssues) {
      const p = issue.priority ?? "medium";
      map[p] = (map[p] ?? 0) + 1;
    }
    return PRIORITY_META.map((m) => ({ ...m, count: map[m.key] ?? 0 }));
  }, [allIssues]);

  const typeCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const issue of allIssues) {
      const t = issue.issueType ?? "task";
      map[t] = (map[t] ?? 0) + 1;
    }
    return TYPE_META.map((m) => ({ ...m, count: map[m.key] ?? 0 }));
  }, [allIssues]);

  const doneCount = useMemo(
    () => columns.filter((c) => c.name === "Done").reduce((s, c) => s + c.issues.length, 0),
    [columns]
  );
  const activeCount = useMemo(
    () => columns.filter((c) => c.name === "In Progress" || c.name === "In Review").reduce((s, c) => s + c.issues.length, 0),
    [columns]
  );
  const blockedCount = useMemo(
    () => allIssues.filter((i) => i.isBlocked).length,
    [allIssues]
  );
  const completionRate = allIssues.length > 0 ? Math.round((doneCount / allIssues.length) * 100) : 0;
  const testSignal = projectStats
    ? projectStats.codeMetrics.testRatio >= 30
      ? "healthy test weight"
      : projectStats.codeMetrics.testRatio > 0
        ? "light test weight"
        : "no tests detected"
    : "loading code metrics";

  // Recently closed issues (Done/Cancelled), sorted by updatedAt desc
  const recentlyDone = useMemo(() => {
    const done = columns
      .filter((c) => c.name === "Done" || c.name === "Cancelled")
      .flatMap((c) => c.issues);
    done.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return done.slice(0, 5);
  }, [columns]);

  if (allIssues.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-3 text-gray-400 dark:text-gray-500">
        <svg className="w-14 h-14 opacity-25" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
        <p className="text-sm">No issues to analyse yet</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto px-4 pb-6">
      <div className="max-w-5xl mx-auto space-y-5 pt-3">

        {/* Summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Total Issues" value={allIssues.length} sub={`across ${columns.filter(c => c.issues.length > 0).length} statuses`} />
          <StatCard label="Active" value={activeCount} sub="In Progress + In Review" color={BRAND} />
          <StatCard label="Completed" value={doneCount} sub={`${completionRate}% completion rate`} color={ACCENT} />
          <StatCard label="Blocked" value={blockedCount} sub="have blocking dependencies" color={blockedCount > 0 ? "#ef4444" : undefined} />
        </div>

        {/* Codebase health */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="lg:col-span-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Code Footprint</h3>
            {projectStats ? (
              <LocSplit stats={projectStats.codeMetrics} />
            ) : (
              <p className="text-xs text-gray-400 dark:text-gray-500">{statsError ?? "Scanning source files..."}</p>
            )}
          </div>

          <div className="lg:col-span-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
            <div className="flex items-baseline justify-between gap-3 mb-2">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Code Growth Trend</h3>
              {projectStats && (
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {projectStats.history.contributorCount} contributors / {testSignal}
                </span>
              )}
            </div>
            {projectStats ? (
              <CodeGrowthChart weeks={projectStats.history.weeks} />
            ) : (
              <div className="h-32 flex items-center text-xs text-gray-400 dark:text-gray-500">
                {statsError ?? "Loading git history..."}
              </div>
            )}
          </div>
        </div>

        {projectStats && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Hot Files</h3>
              {projectStats.hotspots.length === 0 ? (
                <p className="text-xs text-gray-400 dark:text-gray-500">No recent source churn detected</p>
              ) : (
                <div className="space-y-2">
                  {projectStats.hotspots.slice(0, 5).map((file) => (
                    <div key={file.path} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 items-center">
                      <span className="text-xs text-gray-600 dark:text-gray-300 truncate" title={file.path}>{file.path}</span>
                      <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 tabular-nums">
                        {formatCount(file.changes)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Recent Contributors</h3>
              {projectStats.history.topContributors.length === 0 ? (
                <p className="text-xs text-gray-400 dark:text-gray-500">No recent commits found</p>
              ) : (
                <HorizontalBars
                  items={projectStats.history.topContributors.map((contributor, index) => ({
                    key: contributor.name,
                    label: contributor.name,
                    count: contributor.commits,
                    color: index === 0 ? BRAND : ACCENT,
                    lightBg: "",
                    darkBg: "",
                  }))}
                />
              )}
            </div>
          </div>
        )}

        {/* Charts row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Status donut */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">By Status</h3>
            <DonutChart segments={statusSegments} />
          </div>

          {/* Priority breakdown */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">By Priority</h3>
            <HorizontalBars items={priorityCounts} />
          </div>

          {/* Type breakdown */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">By Type</h3>
            <VerticalBars items={typeCounts} />
          </div>
        </div>

        {/* Activity heatmap + Recently done */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div className="md:col-span-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-4">
              Issue Creation Activity
              <span className="ml-2 text-xs font-normal text-gray-400 dark:text-gray-500">
                past {HEATMAP_WEEKS} weeks
              </span>
            </h3>
            <ActivityHeatmap issues={allIssues} />
          </div>

          <div className="md:col-span-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Recently Closed</h3>
            {recentlyDone.length === 0 ? (
              <p className="text-xs text-gray-400 dark:text-gray-500">No completed issues yet</p>
            ) : (
              <div className="flex flex-col gap-2">
                {recentlyDone.map((issue) => (
                  <button
                    key={issue.id}
                    onClick={() => onIssueClick(issue)}
                    className="flex items-start gap-2 text-left group"
                  >
                    <span className="mt-0.5 w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs text-gray-700 dark:text-gray-300 truncate group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors">
                        #{issue.issueNumber} {issue.title}
                      </p>
                      <p className="text-[10px] text-gray-400 dark:text-gray-500">
                        {new Date(issue.updatedAt).toLocaleDateString('en-US', { month: "short", day: "numeric" })}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
