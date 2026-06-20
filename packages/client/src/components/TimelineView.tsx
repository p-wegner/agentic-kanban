import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import {
  TYPE_COLORS,
  PRIORITY_COLORS,
  STATUS_BG,
  STATUS_BADGE,
  ALL_TYPES,
  WEEK_MS,
  MONTH_MS,
  fmtAxisDate,
  fmtTooltipDate,
  computeLanes,
  computeBaseRange,
  computeTicks,
  pctOf,
  toggleTypeSet,
  computeIssueBar,
  type DateRange,
  type Lane,
} from "../lib/timelineView.js";

interface TimelineViewProps {
  columns: StatusWithIssues[];
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery?: string;
}

const LABEL_W = 220;
const BAR_H = 30;
const ROW_H = 46;
const AXIS_H = 28;

interface TooltipState {
  issue: IssueWithStatus;
  x: number;
  y: number;
}

/** Vertical tick gridlines + the "today" marker, shared by the lane header and issue rows. */
function GridLines({ ticks, range, nowPct, strong }: { ticks: Date[]; range: DateRange; nowPct: number; strong?: boolean }) {
  return (
    <>
      {ticks.map((tick, i) => (
        <div key={i} className="absolute top-0 h-full border-l border-gray-100 dark:border-gray-800" style={{ left: `${pctOf(tick.getTime(), range)}%` }} />
      ))}
      {nowPct >= 0 && nowPct <= 100 && (
        <div
          className={`absolute top-0 h-full ${strong ? "border-l-2 border-red-400/30" : "border-l border-red-300/30 dark:border-red-500/20"}`}
          style={{ left: `${nowPct}%` }}
        />
      )}
    </>
  );
}

function TimelineToolbar({
  issueCount, laneCount, showCompleted, setShowCompleted, panOffsetMs, setPanOffsetMs, zoom, setZoom, activeTypes, onToggleType,
}: {
  issueCount: number;
  laneCount: number;
  showCompleted: boolean;
  setShowCompleted: Dispatch<SetStateAction<boolean>>;
  panOffsetMs: number;
  setPanOffsetMs: Dispatch<SetStateAction<number>>;
  zoom: number;
  setZoom: Dispatch<SetStateAction<number>>;
  activeTypes: Set<string>;
  onToggleType: (type: string) => void;
}) {
  const navBtn = "w-6 h-6 text-xs flex items-center justify-center rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300";
  return (
    <div className="flex items-center gap-3 py-2 mb-1 flex-wrap">
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {issueCount} issue{issueCount !== 1 ? "s" : ""} across {laneCount} status{laneCount !== 1 ? "es" : ""}
      </span>
      <button
        onClick={() => setShowCompleted((v) => !v)}
        className={`flex items-center gap-1.5 px-2 h-6 text-xs rounded border transition-colors ${
          showCompleted
            ? "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            : "bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400"
        }`}
        title={showCompleted ? "Hide completed issues" : "Show completed issues"}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${showCompleted ? "bg-green-500" : "bg-gray-400"}`} />
        Show completed
      </button>
      <div className="ml-auto flex items-center gap-1">
        <span className="text-xs text-gray-400 dark:text-gray-500 mr-1">Navigate</span>
        <button onClick={() => setPanOffsetMs((o) => o - MONTH_MS)} className={navBtn} title="Back 1 month">«</button>
        <button onClick={() => setPanOffsetMs((o) => o - WEEK_MS)} className={navBtn} title="Back 1 week">‹</button>
        <button
          onClick={() => setPanOffsetMs(0)}
          className={`px-1.5 h-6 text-xs flex items-center justify-center rounded border bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 min-w-[40px] ${panOffsetMs !== 0 ? "border-brand-400 dark:border-brand-600" : "border-gray-200 dark:border-gray-700"}`}
          title="Reset to today"
        >Today</button>
        <button onClick={() => setPanOffsetMs((o) => o + WEEK_MS)} className={navBtn} title="Forward 1 week">›</button>
        <button onClick={() => setPanOffsetMs((o) => o + MONTH_MS)} className={navBtn} title="Forward 1 month">»</button>
        <span className="text-xs text-gray-400 dark:text-gray-500 mx-2">|</span>
        <span className="text-xs text-gray-400 dark:text-gray-500 mr-1">Zoom</span>
        <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} className={navBtn}>−</button>
        <button onClick={() => setZoom(1)} className="px-1.5 h-6 text-xs flex items-center justify-center rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 min-w-[40px]">{Math.round(zoom * 100)}%</button>
        <button onClick={() => setZoom((z) => Math.min(5, +(z + 0.25).toFixed(2)))} className={navBtn}>+</button>
      </div>
      <div className="flex items-center gap-1">
        {Object.entries(TYPE_COLORS).map(([type, cls]) => {
          const isActive = activeTypes.has(type);
          return (
            <button
              key={type}
              onClick={() => onToggleType(type)}
              title={isActive ? `Hide ${type}s` : `Show ${type}s`}
              className={`flex items-center gap-1.5 px-2 h-6 text-xs rounded border transition-all select-none ${
                isActive
                  ? `${cls.bg} ${cls.border} ${cls.text} hover:brightness-95 dark:hover:brightness-110`
                  : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-600 opacity-50 hover:opacity-75"
              }`}
            >
              <span
                className="w-2.5 h-2.5 rounded border shrink-0"
                style={isActive ? { background: cls.dot + "33", borderColor: cls.dot + "99" } : { background: "transparent", borderColor: "currentColor" }}
              />
              {type.charAt(0).toUpperCase() + type.slice(1)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TimelineLane({
  lane, laneIdx, ticks, range, nowPct, onIssueClick, setTooltip,
}: {
  lane: Lane;
  laneIdx: number;
  ticks: Date[];
  range: DateRange;
  nowPct: number;
  onIssueClick: (issue: IssueWithStatus) => void;
  setTooltip: (t: TooltipState | null) => void;
}) {
  return (
    <div className={`${STATUS_BG[lane.name] ?? "bg-surface-raised dark:bg-surface-raised-dark"} ${laneIdx > 0 ? "border-t border-gray-200 dark:border-gray-700" : ""}`}>
      {/* Lane header */}
      <div className="flex items-center sticky top-[28px] z-[5]" style={{ height: 28 }}>
        <div
          className={`flex items-center gap-2 px-3 border-r border-gray-200 dark:border-gray-700 h-full ${STATUS_BG[lane.name] ?? ""} border-b border-gray-100 dark:border-gray-800`}
          style={{ width: LABEL_W, minWidth: LABEL_W }}
        >
          <span className={`text-xs font-semibold truncate ${STATUS_BADGE[lane.name] ?? "text-gray-600 dark:text-gray-400"}`}>{lane.name}</span>
          <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto shrink-0">{lane.issues.length}</span>
        </div>
        <div className={`flex-1 h-full border-b border-gray-100 dark:border-gray-800 relative ${STATUS_BG[lane.name] ?? ""}`}>
          <GridLines ticks={ticks} range={range} nowPct={nowPct} strong />
        </div>
      </div>

      {/* Issue rows */}
      {lane.issues.map((issue) => {
        const { startPct: startP, spanPct: spanP, colors: cls, priorityColor: priColor } = computeIssueBar(issue, range);
        return (
          <div key={issue.id} className="flex items-center border-b border-gray-50 dark:border-gray-800" style={{ height: ROW_H }}>
            <div
              className="flex items-center gap-1.5 px-2 border-r border-gray-100 dark:border-gray-800 h-full shrink-0 overflow-hidden"
              style={{ width: LABEL_W, minWidth: LABEL_W }}
            >
              <span className="text-[11px] text-gray-400 dark:text-gray-500 shrink-0">#{issue.issueNumber}</span>
              <span className="text-[11px] text-gray-600 dark:text-gray-400 truncate" title={issue.title}>{issue.title}</span>
            </div>
            <div className="flex-1 relative h-full">
              <GridLines ticks={ticks} range={range} nowPct={nowPct} />
              <div
                className={`absolute top-1/2 -translate-y-1/2 rounded-md border cursor-pointer
                  transition-all hover:shadow-md hover:brightness-95 dark:hover:brightness-110
                  flex items-center gap-1.5 px-2 overflow-hidden select-none
                  ${cls.bg} ${cls.border}`}
                style={{ left: `${startP}%`, width: `max(90px, ${spanP}%)`, height: BAR_H }}
                onClick={() => onIssueClick(issue)}
                onMouseEnter={(e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setTooltip({ issue, x: rect.left + rect.width / 2, y: rect.top });
                }}
                onMouseLeave={() => setTooltip(null)}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: priColor }} title={`Priority: ${issue.priority ?? "medium"}`} />
                <span className={`text-xs font-medium truncate ${cls.text}`}>{issue.title}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TimelineTooltip({ tooltip }: { tooltip: TooltipState }) {
  return (
    <div
      className="fixed z-50 pointer-events-none bg-surface-raised dark:bg-surface-raised-dark border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl p-3 text-xs max-w-xs"
      style={{ left: tooltip.x, top: tooltip.y - 12, transform: "translate(-50%, -100%)" }}
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
        {tooltip.issue.dueDate && (
          <div className="flex gap-2">
            <span className="w-14 shrink-0 text-gray-400">Due</span>
            <span className={new Date(tooltip.issue.dueDate) < new Date(new Date().toDateString()) ? "text-red-500 font-medium" : ""}>
              {fmtTooltipDate(new Date(tooltip.issue.dueDate))}
            </span>
          </div>
        )}
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
  );
}

export function TimelineView({ columns, onIssueClick, searchQuery }: TimelineViewProps) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panOffsetMs, setPanOffsetMs] = useState(0);
  const [showCompleted, setShowCompleted] = useState(true);
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set(ALL_TYPES));
  const scrollRef = useRef<HTMLDivElement>(null);

  const q = searchQuery?.toLowerCase() ?? "";

  const toggleType = (type: string) => setActiveTypes((prev) => toggleTypeSet(prev, type));

  const lanes = useMemo(
    () => computeLanes(columns, { showCompleted, activeTypes, query: q }),
    [columns, q, showCompleted, activeTypes],
  );

  const allIssues = useMemo(() => lanes.flatMap((l) => l.issues), [lanes]);

  const baseRange = useMemo(() => computeBaseRange(allIssues), [allIssues]);

  const range = useMemo(() => ({
    min: baseRange.min + panOffsetMs,
    max: baseRange.max + panOffsetMs,
  }), [baseRange, panOffsetMs]);

  const ticks = useMemo(() => computeTicks(range), [range]);

  const span = range.max - range.min;
  const now = Date.now();

  const pct = (ts: number): number => pctOf(ts, range);

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
      <TimelineToolbar
        issueCount={allIssues.length}
        laneCount={lanes.length}
        showCompleted={showCompleted}
        setShowCompleted={setShowCompleted}
        panOffsetMs={panOffsetMs}
        setPanOffsetMs={setPanOffsetMs}
        zoom={zoom}
        setZoom={setZoom}
        activeTypes={activeTypes}
        onToggleType={toggleType}
      />

      {/* Timeline scroll area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark"
      >
        <div style={{ minWidth }}>

          {/* Date axis row */}
          <div className="flex sticky top-0 z-10 bg-surface-raised dark:bg-surface-raised-dark border-b border-gray-200 dark:border-gray-700" style={{ height: AXIS_H }}>
            <div style={{ width: LABEL_W, minWidth: LABEL_W }} className="border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800" />
            <div className="flex-1 relative">
              {ticks.map((tick, i) => (
                <div
                  key={i}
                  className="absolute top-0 h-full flex items-center"
                  style={{ left: `${pct(tick.getTime())}%` }}
                >
                  <span className="text-xs text-gray-400 dark:text-gray-500 -translate-x-1/2 whitespace-nowrap select-none px-1">
                    {fmtAxisDate(tick, span)}
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
            <TimelineLane
              key={lane.name}
              lane={lane}
              laneIdx={laneIdx}
              ticks={ticks}
              range={range}
              nowPct={nowPct}
              onIssueClick={onIssueClick}
              setTooltip={setTooltip}
            />
          ))}
        </div>
      </div>

      {tooltip && <TimelineTooltip tooltip={tooltip} />}
    </div>
  );
}
