import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import {
  TYPE_COLORS,
  PRIORITY_COLORS,
  STATUS_BG,
  STATUS_BADGE,
  ALL_TYPES,
  fmtTooltipDate,
  computeLanes,
  pctOf,
  toggleTypeSet,
  computeIssueBar,
  type DateRange,
  type Lane,
} from "../lib/timelineView.js";
import {
  DAY_MS,
  stepAnchor,
  ticksFor,
  viewportForFitAll,
  viewportForToday,
  windowFor,
  withScale,
  zoomAround,
  type Scale,
  type TimeWindow,
  type Viewport,
} from "../lib/timeScale.js";
import { TIMELINE_VIEW_ID, type TimelineScaleId } from "../lib/viewTabs.js";
import { useViewTab } from "../hooks/useViewTab.js";
import { useTimelineViewStore } from "../stores/timelineViewStore.js";
import { Icon } from "./Icon.js";

const SCALES: readonly Scale[] = ["day", "week", "month", "quarter"];
const SCALE_LABELS: Record<Scale, string> = { day: "Day", week: "Week", month: "Month", quarter: "Quarter" };

/** The [min,max] of `issues`' created→due/updated dates, folding in "now" (never empty). */
function issueDateRange(issues: IssueWithStatus[]): { min: number; max: number } {
  if (issues.length === 0) {
    const now = Date.now();
    return { min: now - 7 * DAY_MS, max: now };
  }
  const dates = issues.flatMap((i) => [
    new Date(i.createdAt).getTime(),
    i.dueDate ? new Date(i.dueDate).getTime() : new Date(i.updatedAt).getTime(),
  ]);
  return { min: Math.min(...dates), max: Math.max(...dates, Date.now()) };
}

interface TimelineViewProps {
  columns: StatusWithIssues[];
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery?: string;
  /** Scopes the persisted anchor/zoom/filter state (below) to one project. */
  projectId?: string | null;
}

const LABEL_W = 220;
const BAR_H = 30;
/** Floor on a bar's rendered width: a same-day issue is 0% wide and would be invisible. */
const MIN_BAR_W = 90;
const ROW_H = 46;
const AXIS_H = 28;

interface TooltipState {
  issue: IssueWithStatus;
  x: number;
  y: number;
}

/**
 * How close to an end of the track a tick has to be before its label is anchored to that end
 * rather than centred (#897). A percentage, not a pixel count, because the label's own width is
 * unknown at render time — 3% of a ~1150px track is ~35px, comfortably more than the half-width
 * of the widest date format the axis emits.
 */
const AXIS_EDGE_PCT = 3;

/**
 * Position the tick's container.
 *
 * `width: 0` off the right edge is the part that is easy to get wrong: `-translate-x-1/2`
 * moves the LABEL but not its shrink-wrapped parent, so a container left at its natural width
 * still juts `labelWidth` px past its `left: p%` origin and overflows on its own — invisible
 * at 1440px, a 6px scrollbar at 900px. Collapsing it to zero width makes the transformed label
 * the only box that can define the track's scroll extent. The final tick keeps a real width
 * because it is pinned by its RIGHT edge, where a zero-width box would put the label outside.
 */
export function axisAnchor(p: number): { left: string; width: number } | { right: number } {
  return p >= 100 - AXIS_EDGE_PCT ? { right: 0 } : { left: `${p}%`, width: 0 };
}

/** Centre the label on its tick, except at the two ends where it would leave the track. */
export function axisLabelShift(p: number): string {
  if (p >= 100 - AXIS_EDGE_PCT) return "";
  if (p <= AXIS_EDGE_PCT) return "";
  return "-translate-x-1/2";
}

/** Vertical tick gridlines + the "today" marker, shared by the lane header and issue rows. */
function GridLines({
  majorTicks, minorTicks, range, nowPct, strong,
}: {
  majorTicks: number[];
  minorTicks: number[];
  range: DateRange;
  nowPct: number;
  strong?: boolean;
}) {
  return (
    <>
      {/*
        #897: `min(…, calc(100% - 1px))` keeps the rule ON the track. A 1px border drawn at
        exactly left:100% sits one pixel outside its container, and one pixel of scrollable
        overflow paints a full scrollbar — the range's last tick is always at 100%, so this
        fired on every render.

        Two bands (#1088): minor ticks are the finer calendar unit (hours/days/weeks/months
        depending on scale) drawn faint; major ticks are the labelled boundary and drawn solid.
      */}
      {minorTicks.map((ts, i) => (
        <div key={`mi-${i}`} className="absolute top-0 h-full border-l border-gray-50 dark:border-gray-800/50" style={{ left: `min(${pctOf(ts, range)}%, calc(100% - 1px))` }} />
      ))}
      {majorTicks.map((ts, i) => (
        <div key={`ma-${i}`} className="absolute top-0 h-full border-l border-gray-100 dark:border-gray-800" style={{ left: `min(${pctOf(ts, range)}%, calc(100% - 1px))` }} />
      ))}
      {nowPct >= 0 && nowPct <= 100 && (
        <div
          className={`absolute top-0 h-full ${strong ? "border-l-2 border-red-400/30" : "border-l border-red-300/30 dark:border-red-500/20"}`}
          style={{ left: `min(${nowPct}%, calc(100% - 2px))` }}
        />
      )}
    </>
  );
}

function TimelineToolbar({
  issueCount, laneCount, showCompleted, setShowCompleted, scale, onSetScale, onStep, onToday, onFitAll, onZoom, activeTypes, onToggleType,
}: {
  issueCount: number;
  laneCount: number;
  showCompleted: boolean;
  setShowCompleted: Dispatch<SetStateAction<boolean>>;
  scale: Scale;
  onSetScale: (scale: Scale) => void;
  onStep: (direction: 1 | -1) => void;
  onToday: () => void;
  onFitAll: () => void;
  onZoom: (factor: number) => void;
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
      <div className="flex items-center gap-1">
        {SCALES.map((s) => (
          <button
            key={s}
            onClick={() => onSetScale(s)}
            className={`px-2 h-6 text-xs rounded border transition-colors ${
              s === scale
                ? "bg-brand-50 dark:bg-brand-950/30 border-brand-300 dark:border-brand-700 text-brand-700 dark:text-brand-400"
                : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            }`}
          >
            {SCALE_LABELS[s]}
          </button>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-1">
        <span className="text-xs text-gray-400 dark:text-gray-500 mr-1">Navigate</span>
        <button onClick={() => onStep(-1)} className={navBtn} title={`Back 1 ${scale}`}>‹</button>
        <button
          onClick={onToday}
          className="px-1.5 h-6 text-xs flex items-center justify-center rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 min-w-[40px]"
          title="Recenter on today"
        >Today</button>
        <button onClick={() => onStep(1)} className={navBtn} title={`Forward 1 ${scale}`}>›</button>
        <button
          onClick={onFitAll}
          className="px-1.5 h-6 text-xs flex items-center justify-center rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300"
          title="Fit all visible issues"
        >Fit all</button>
        <span className="text-xs text-gray-400 dark:text-gray-500 mx-2">|</span>
        <span className="text-xs text-gray-400 dark:text-gray-500 mr-1">Zoom</span>
        <button onClick={() => onZoom(1 / 1.25)} className={navBtn} title="Zoom out">−</button>
        <button onClick={() => onZoom(1.25)} className={navBtn} title="Zoom in">+</button>
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
  lane, laneIdx, majorTicks, minorTicks, range, nowPct, onIssueClick, setTooltip,
}: {
  lane: Lane;
  laneIdx: number;
  majorTicks: number[];
  minorTicks: number[];
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
          <GridLines majorTicks={majorTicks} minorTicks={minorTicks} range={range} nowPct={nowPct} strong />
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
              <GridLines majorTicks={majorTicks} minorTicks={minorTicks} range={range} nowPct={nowPct} />
              <div
                className={`absolute top-1/2 -translate-y-1/2 rounded-md border cursor-pointer
                  transition-all hover:shadow-md hover:brightness-95 dark:hover:brightness-110
                  flex items-center gap-1.5 px-2 overflow-hidden select-none
                  ${cls.bg} ${cls.border}`}
                /*
                  #897: the bar is clamped so it cannot spill past the track.
                  `pctOf` already clamps to 0-100, so the percentages alone never overflow —
                  the sole cause was the `max(MIN_BAR_W, …)` readability floor, which widens a
                  short bar beyond its true span while still anchoring it by its LEFT edge. An
                  issue created near the right end of the range therefore painted up to
                  MIN_BAR_W past 100% and gave the whole view a horizontal scrollbar for ~48px
                  of nothing. Measured on /p/agentic-kanban/timeline at 1440x900.

                  The floor is kept — it is what makes a same-day issue readable at all — so
                  the fix clamps both ends instead of dropping it: the left edge never gets
                  closer than MIN_BAR_W to the track's right edge (so the floor always fits),
                  and max-width caps the bar at whatever track remains. The `max(0px, …)` is
                  for a track narrower than MIN_BAR_W, where the inner clamp would otherwise
                  go negative and push the bar off the LEFT edge instead.
                */
                style={{
                  ["--bar-left" as string]: `min(${startP}%, max(0px, calc(100% - ${MIN_BAR_W}px)))`,
                  left: "var(--bar-left)",
                  width: `max(${MIN_BAR_W}px, ${spanP}%)`,
                  maxWidth: "calc(100% - var(--bar-left))",
                  height: BAR_H,
                }}
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

/** Default track width used before the scroll container has been measured (e.g. static render). */
const DEFAULT_TRACK_PX = 1200;

export function TimelineView({ columns, onIssueClick, searchQuery, projectId }: TimelineViewProps) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [trackPx, setTrackPx] = useState(DEFAULT_TRACK_PX);
  const scrollRef = useRef<HTMLDivElement>(null);

  // #1090: scale is a URL tab (VIEW_TAB_REGISTRY), so `/p/<slug>/timeline/week` is a real deep
  // link and the toolbar's scale buttons below double as that tab's selector — a second
  // <ViewTabBar> would just duplicate them, since "timeline" stays one component per tab.
  const [tab, setTab] = useViewTab<TimelineScaleId>(TIMELINE_VIEW_ID);

  // #1090: anchor/zoom and the filter toggles survive a view switch via a small persisted
  // store, read once at mount (imperative `getState`, not a subscription — nothing here needs
  // to react to a later write, since this component is the only writer) — a plain `useState`
  // reset to the defaults every time the user came back to this view, even though the scale
  // (URL tab) and the search box (global filter store) already didn't.
  //
  // Keyed by project, not just by view id: an anchor/zoom is a position in ONE project's
  // issue-date range, and `TIMELINE_VIEW_ID` alone is the same constant for every project on
  // the board — without the project in the key, switching projects while on the Timeline view
  // would restore the previous project's anchor (often outside the new project's data range)
  // instead of resetting to a sensible default.
  const storeKey = `${projectId ?? "none"}:${TIMELINE_VIEW_ID}`;
  const persistedAtMount = useRef(useTimelineViewStore.getState().byView[storeKey]).current;

  const [showCompleted, setShowCompleted] = useState(persistedAtMount?.showCompleted ?? true);
  const [activeTypes, setActiveTypes] = useState<Set<string>>(
    () => new Set(persistedAtMount?.activeTypes ?? ALL_TYPES),
  );

  const q = searchQuery?.toLowerCase() ?? "";

  const toggleType = (type: string) => setActiveTypes((prev) => toggleTypeSet(prev, type));

  const lanes = useMemo(
    () => computeLanes(columns, { showCompleted, activeTypes, query: q }),
    [columns, q, showCompleted, activeTypes],
  );

  const allIssues = useMemo(() => lanes.flatMap((l) => l.issues), [lanes]);

  // Unfiltered, so the initial viewport isn't at the mercy of the default filter state.
  const allIssuesUnfiltered = useMemo(() => columns.flatMap((c) => c.issues), [columns]);

  // #1088 (R1/R2/P1-6): the viewport (scale/anchor/zoom) is independent state, computed once
  // from the data on mount rather than re-derived from whatever is currently filtered — that
  // decoupling is what stops the axis window rescaling under the user on every search/filter
  // change. Real zoom (day/week/month/quarter, real time-scale math) replaces the old CSS
  // `min-width` multiplier that had no effect on what was actually shown.
  //
  // #1090: `scale` is not part of this local state — it comes from `tab` above. Only the
  // pan/zoom half (anchor, pxPerMs) is tracked here, restored from the persisted store when
  // present so re-entering the view doesn't jump back to "fit all".
  //
  // A fresh, never-visited-before mount (no persisted state, no explicit URL tab) now fits
  // the data at `tab`'s resolved value (the registry default, "month") rather than #1088's
  // auto-picked scale — a stable default is what makes the URL tab meaningful at all;
  // deriving it from the data would make the very same URL show a different scale depending
  // on what is currently open, and disagree with what "Fit all" recomputes later anyway.
  const [zoomState, setZoomState] = useState<{ anchor: number; pxPerMs: number }>(() => {
    if (persistedAtMount) return { anchor: persistedAtMount.anchor, pxPerMs: persistedAtMount.pxPerMs };
    const { min, max } = issueDateRange(allIssuesUnfiltered);
    return viewportForFitAll(min, max, DEFAULT_TRACK_PX, tab);
  });

  const viewport: Viewport = useMemo(
    () => ({ scale: tab, anchor: zoomState.anchor, pxPerMs: zoomState.pxPerMs }),
    [tab, zoomState],
  );

  useEffect(() => {
    useTimelineViewStore.getState().set(storeKey, {
      anchor: zoomState.anchor,
      pxPerMs: zoomState.pxPerMs,
      showCompleted,
      activeTypes: [...activeTypes],
    });
  }, [storeKey, zoomState, showCompleted, activeTypes]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setTrackPx(Math.max(300, Math.round(width)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const timeWindow: TimeWindow = useMemo(() => windowFor(viewport, trackPx), [viewport, trackPx]);
  const { major: majorTickList, minor: minorTickList } = useMemo(
    () => ticksFor(timeWindow, viewport.scale),
    [timeWindow, viewport.scale],
  );
  const majorTicks = useMemo(() => majorTickList.map((t) => t.ts), [majorTickList]);
  const minorTicks = useMemo(() => minorTickList.map((t) => t.ts), [minorTickList]);

  const now = Date.now();
  const pct = (ts: number): number => pctOf(ts, timeWindow);

  /** Apply a computed Viewport: publish a scale change to the URL tab, keep anchor/zoom local. */
  const applyViewport = (next: Viewport) => {
    if (next.scale !== tab) setTab(next.scale);
    setZoomState({ anchor: next.anchor, pxPerMs: next.pxPerMs });
  };

  const handleSetScale = (scale: Scale) => applyViewport(withScale(viewport, scale, (timeWindow.min + timeWindow.max) / 2, trackPx));
  const handleStep = (direction: 1 | -1) => applyViewport(stepAnchor(viewport, direction));
  const handleToday = () => applyViewport(viewportForToday(viewport.scale, viewport.pxPerMs, trackPx));
  const handleZoom = (factor: number) => applyViewport(zoomAround(viewport, factor, (timeWindow.min + timeWindow.max) / 2, trackPx));
  const handleFitAll = () => {
    const source = allIssues.length > 0 ? allIssues : allIssuesUnfiltered;
    const { min, max } = issueDateRange(source);
    applyViewport(viewportForFitAll(min, max, trackPx));
  };

  if (allIssues.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-3 text-gray-400 dark:text-gray-500">
        <Icon className="w-14 h-14 opacity-25" strokeWidth={1} d="M6 6h12M6 10h8M6 14h5M6 18h3" />
        <p className="text-sm">No issues to display on the timeline</p>
      </div>
    );
  }

  const nowPct = pct(now);

  return (
    <div className="flex flex-col flex-1 min-h-0 px-4 pb-4">
      <TimelineToolbar
        issueCount={allIssues.length}
        laneCount={lanes.length}
        showCompleted={showCompleted}
        setShowCompleted={setShowCompleted}
        scale={viewport.scale}
        onSetScale={handleSetScale}
        onStep={handleStep}
        onToday={handleToday}
        onFitAll={handleFitAll}
        onZoom={handleZoom}
        activeTypes={activeTypes}
        onToggleType={toggleType}
      />

      {/* Timeline scroll area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark"
      >
        <div style={{ minWidth: 700 }}>

          {/* Date axis row */}
          <div className="flex sticky top-0 z-10 bg-surface-raised dark:bg-surface-raised-dark border-b border-gray-200 dark:border-gray-700" style={{ height: AXIS_H }}>
            <div style={{ width: LABEL_W, minWidth: LABEL_W }} className="border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800" />
            <div className="flex-1 relative">
              {/*
                #897: an axis label is centred on its tick, so at the range's FIRST and LAST
                tick half of it hangs outside the track — measured as the 48px horizontal
                scrollbar this view painted at 1440x900. Clipping the strip would hide half a
                date; nudging the tick would put the label under the wrong day. So only the
                LABEL's anchor changes at the two edges: flush-left at the start, flush-right
                at the end, centred everywhere in between. Every date stays fully readable and
                none of them leaves the track.

                #1088: labels come pre-computed from `ticksFor` (calendar-boundary-snapped,
                scale-aware — "Week of Mar 9", "September 2026", "Q3 2026") instead of the old
                span-proportional `fmtAxisDate`.
              */}
              {majorTickList.map((tick, i) => (
                <div key={i} className="absolute top-0 h-full flex items-center" style={axisAnchor(pct(tick.ts))}>
                  <span className={`text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap select-none px-1 shrink-0 ${axisLabelShift(pct(tick.ts))}`}>
                    {tick.label}
                  </span>
                </div>
              ))}
              {nowPct >= 0 && nowPct <= 100 && (
                <div className="absolute top-0 h-full flex items-end pb-0.5" style={axisAnchor(nowPct)}>
                  <span className={`text-[10px] font-bold text-red-500 whitespace-nowrap select-none shrink-0 ${axisLabelShift(nowPct)}`}>
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
              majorTicks={majorTicks}
              minorTicks={minorTicks}
              range={timeWindow}
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
