import { useMemo, useRef, useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";

interface TimelineViewProps {
  columns: StatusWithIssues[];
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery?: string;
}

const TYPE_COLORS: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  task:    { bg: "bg-blue-100 dark:bg-blue-900/50",    border: "border-blue-300 dark:border-blue-700",    text: "text-blue-800 dark:text-blue-200",    dot: "#3b82f6" },
  bug:     { bg: "bg-red-100 dark:bg-red-900/50",      border: "border-red-300 dark:border-red-700",      text: "text-red-800 dark:text-red-200",      dot: "#ef4444" },
  feature: { bg: "bg-violet-100 dark:bg-violet-900/50", border: "border-violet-300 dark:border-violet-700", text: "text-violet-800 dark:text-violet-200", dot: "#8b5cf6" },
  chore:   { bg: "bg-amber-100 dark:bg-amber-900/50",  border: "border-amber-300 dark:border-amber-700",  text: "text-amber-800 dark:text-amber-200",  dot: "#f59e0b" },
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high:     "#f97316",
  medium:   "#eab308",
  low:      "#6b7280",
};

const STATUS_BG: Record<string, string> = {
  "Todo":        "bg-gray-50 dark:bg-gray-900",
  "In Progress": "bg-blue-50/50 dark:bg-blue-950/20",
  "In Review":   "bg-violet-50/50 dark:bg-violet-950/20",
  "AI Reviewed": "bg-cyan-50/50 dark:bg-cyan-950/20",
  "Done":        "bg-green-50/50 dark:bg-green-950/20",
  "Cancelled":   "bg-gray-100/50 dark:bg-gray-800/30",
};

const STATUS_BADGE: Record<string, string> = {
  "Todo":        "text-gray-600 dark:text-gray-400",
  "In Progress": "text-blue-700 dark:text-blue-300",
  "In Review":   "text-violet-700 dark:text-violet-300",
  "AI Reviewed": "text-cyan-700 dark:text-cyan-300",
  "Done":        "text-green-700 dark:text-green-300",
  "Cancelled":   "text-gray-500 dark:text-gray-500",
};

const LABEL_W = 148;
const BAR_H = 30;
const ROW_H = 46;
const AXIS_H = 28;

function fmtAxisDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function fmtTooltipDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

interface TooltipState {
  issue: IssueWithStatus;
  x: number;
  y: number;
}

export function TimelineView({ columns, onIssueClick, searchQuery }: TimelineViewProps) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  const q = searchQuery?.toLowerCase() ?? "";

  const lanes = useMemo(() =>
    columns
      .map((col) => ({
        name: col.name,
        issues: col.issues.filter((i) =>
          !q || i.title.toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q)
        ),
      }))
      .filter((lane) => lane.issues.length > 0),
    [columns, q]
  );

  const allIssues = useMemo(() => lanes.flatMap((l) => l.issues), [lanes]);

  const range = useMemo(() => {
    if (allIssues.length === 0) {
      const now = Date.now();
      return { min: now - 7 * 86_400_000, max: now };
    }
    const dates = allIssues.flatMap((i) => [
      new Date(i.createdAt).getTime(),
      new Date(i.updatedAt).getTime(),
    ]);
    const rawMin = Math.min(...dates);
    const rawMax = Math.max(...dates, Date.now());
    const span = Math.max(rawMax - rawMin, 86_400_000); // at least 1 day
    const pad = span * 0.04;
    return { min: rawMin - pad, max: rawMax + pad };
  }, [allIssues]);

  const ticks = useMemo(() => {
    const span = range.max - range.min;
    const days = span / 86_400_000;
    const count = Math.min(10, Math.max(4, Math.floor(days / 3)));
    return Array.from({ length: count + 1 }, (_, i) =>
      new Date(range.min + (i / count) * span)
    );
  }, [range]);

  const now = Date.now();

  function pct(ts: number): number {
    return ((ts - range.min) / (range.max - range.min)) * 100;
  }

  if (allIssues.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-3 text-gray-400 dark:text-gray-500">
        <svg className="w-14 h-14 opacity-25" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h12M6 10h8M6 14h5M6 18h3" />
        </svg>
        <p className="text-sm">No issues to display on the timeline</p>
      </div>
    );
  }

  const nowPct = pct(now);
  const minWidth = Math.max(700, 700 * zoom);

  return (
    <div className="flex flex-col flex-1 min-h-0 px-4 pb-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3 py-2 mb-1 flex-wrap">
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {allIssues.length} issue{allIssues.length !== 1 ? "s" : ""} across {lanes.length} status{lanes.length !== 1 ? "es" : ""}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <span className="text-xs text-gray-400 dark:text-gray-500 mr-1">Zoom</span>
          <button
            onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}
            className="w-6 h-6 text-xs flex items-center justify-center rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300"
          >−</button>
          <button
            onClick={() => setZoom(1)}
            className="px-1.5 h-6 text-xs flex items-center justify-center rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 min-w-[40px]"
          >{Math.round(zoom * 100)}%</button>
          <button
            onClick={() => setZoom((z) => Math.min(5, +(z + 0.25).toFixed(2)))}
            className="w-6 h-6 text-xs flex items-center justify-center rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300"
          >+</button>
        </div>
        {/* Legend */}
        <div className="flex items-center gap-4">
          {Object.entries(TYPE_COLORS).map(([type, cls]) => (
            <span key={type} className={`flex items-center gap-1.5 text-xs ${cls.text}`}>
              <span className="w-2.5 h-2.5 rounded border" style={{ background: cls.dot + "33", borderColor: cls.dot + "99" }} />
              {type.charAt(0).toUpperCase() + type.slice(1)}
            </span>
          ))}
        </div>
      </div>

      {/* Timeline scroll area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
      >
        <div style={{ minWidth }}>

          {/* Date axis row */}
          <div className="flex sticky top-0 z-10 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700" style={{ height: AXIS_H }}>
            <div style={{ width: LABEL_W, minWidth: LABEL_W }} className="border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800" />
            <div className="flex-1 relative">
              {ticks.map((tick, i) => (
                <div
                  key={i}
                  className="absolute top-0 h-full flex items-center"
                  style={{ left: `${pct(tick.getTime())}%` }}
                >
                  <span className="text-xs text-gray-400 dark:text-gray-500 -translate-x-1/2 whitespace-nowrap select-none px-1">
                    {fmtAxisDate(tick)}
                  </span>
                </div>
              ))}
              {nowPct >= 0 && nowPct <= 100 && (
                <div
                  className="absolute top-0 h-full flex items-end pb-0.5"
                  style={{ left: `${nowPct}%` }}
                >
                  <span className="text-[10px] font-bold text-red-500 -translate-x-1/2 whitespace-nowrap select-none">
                    Today
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Status lanes */}
          {lanes.map((lane, laneIdx) => (
            <div key={lane.name} className={`${STATUS_BG[lane.name] ?? "bg-white dark:bg-gray-900"} ${laneIdx > 0 ? "border-t border-gray-200 dark:border-gray-700" : ""}`}>
              {/* Lane header */}
              <div className="flex items-center sticky top-[28px] z-[5]" style={{ height: 28 }}>
                <div
                  className={`flex items-center gap-2 px-3 border-r border-gray-200 dark:border-gray-700 h-full ${STATUS_BG[lane.name] ?? ""} border-b border-gray-100 dark:border-gray-800`}
                  style={{ width: LABEL_W, minWidth: LABEL_W }}
                >
                  <span className={`text-xs font-semibold truncate ${STATUS_BADGE[lane.name] ?? "text-gray-600 dark:text-gray-400"}`}>
                    {lane.name}
                  </span>
                  <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto shrink-0">
                    {lane.issues.length}
                  </span>
                </div>
                {/* Grid line for lane header */}
                <div className={`flex-1 h-full border-b border-gray-100 dark:border-gray-800 relative ${STATUS_BG[lane.name] ?? ""}`}>
                  {ticks.map((tick, i) => (
                    <div key={i} className="absolute top-0 h-full border-l border-gray-100 dark:border-gray-800" style={{ left: `${pct(tick.getTime())}%` }} />
                  ))}
                  {nowPct >= 0 && nowPct <= 100 && (
                    <div className="absolute top-0 h-full border-l-2 border-red-400/30" style={{ left: `${nowPct}%` }} />
                  )}
                </div>
              </div>

              {/* Issue rows */}
              {lane.issues.map((issue) => {
                const start = new Date(issue.createdAt).getTime();
                const end = new Date(issue.updatedAt).getTime();
                const startP = pct(start);
                const spanP = Math.max(0, pct(end) - startP);
                const type = issue.issueType ?? "task";
                const cls = TYPE_COLORS[type] ?? TYPE_COLORS.task;
                const priColor = PRIORITY_COLORS[issue.priority ?? "medium"] ?? PRIORITY_COLORS.medium;

                return (
                  <div key={issue.id} className="flex items-center border-b border-gray-50 dark:border-gray-850" style={{ height: ROW_H }}>
                    {/* Label column */}
                    <div
                      className="flex items-center gap-1 px-2 border-r border-gray-100 dark:border-gray-800 h-full shrink-0"
                      style={{ width: LABEL_W, minWidth: LABEL_W }}
                    >
                      <span className="text-[11px] text-gray-400 dark:text-gray-500 shrink-0">
                        #{issue.issueNumber}
                      </span>
                    </div>

                    {/* Bar area */}
                    <div className="flex-1 relative h-full">
                      {/* Grid lines */}
                      {ticks.map((tick, i) => (
                        <div key={i} className="absolute top-0 h-full border-l border-gray-100 dark:border-gray-800" style={{ left: `${pct(tick.getTime())}%` }} />
                      ))}
                      {/* Today line */}
                      {nowPct >= 0 && nowPct <= 100 && (
                        <div className="absolute top-0 h-full border-l border-red-300/30 dark:border-red-500/20" style={{ left: `${nowPct}%` }} />
                      )}

                      {/* Issue bar */}
                      <div
                        className={`absolute top-1/2 -translate-y-1/2 rounded-md border cursor-pointer
                          transition-all hover:shadow-md hover:brightness-95 dark:hover:brightness-110
                          flex items-center gap-1.5 px-2 overflow-hidden select-none
                          ${cls.bg} ${cls.border}`}
                        style={{
                          left: `${startP}%`,
                          width: `max(90px, ${spanP}%)`,
                          height: BAR_H,
                        }}
                        onClick={() => onIssueClick(issue)}
                        onMouseEnter={(e) => {
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setTooltip({ issue, x: rect.left + rect.width / 2, y: rect.top });
                        }}
                        onMouseLeave={() => setTooltip(null)}
                      >
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: priColor }}
                          title={`Priority: ${issue.priority ?? "medium"}`}
                        />
                        <span className={`text-xs font-medium truncate ${cls.text}`}>
                          {issue.title}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Floating tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl p-3 text-xs max-w-xs"
          style={{
            left: tooltip.x,
            top: tooltip.y - 12,
            transform: "translate(-50%, -100%)",
          }}
        >
          <div className="font-semibold text-gray-900 dark:text-gray-100 mb-1.5 flex items-center gap-1.5">
            <span className="text-gray-400 dark:text-gray-500">#{tooltip.issue.issueNumber}</span>
            <span className="truncate">{tooltip.issue.title}</span>
          </div>
          <div className="space-y-0.5 text-gray-500 dark:text-gray-400">
            <div className="flex gap-2">
              <span className="w-14 shrink-0 text-gray-400">Created</span>
              {fmtTooltipDate(new Date(tooltip.issue.createdAt))}
            </div>
            <div className="flex gap-2">
              <span className="w-14 shrink-0 text-gray-400">Updated</span>
              {fmtTooltipDate(new Date(tooltip.issue.updatedAt))}
            </div>
            <div className="flex gap-2">
              <span className="w-14 shrink-0 text-gray-400">Type</span>
              <span className="capitalize">{tooltip.issue.issueType ?? "task"}</span>
            </div>
            <div className="flex gap-2">
              <span className="w-14 shrink-0 text-gray-400">Priority</span>
              <span className="capitalize" style={{ color: PRIORITY_COLORS[tooltip.issue.priority ?? "medium"] }}>
                {tooltip.issue.priority ?? "medium"}
              </span>
            </div>
            {(tooltip.issue.tags ?? []).length > 0 && (
              <div className="flex gap-2 flex-wrap pt-0.5">
                {(tooltip.issue.tags ?? []).map((tag) => (
                  <span key={tag.id} className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                    {tag.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
