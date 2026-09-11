import type { Dispatch, SetStateAction } from "react";
import { TYPE_COLORS, PRIORITY_COLORS, PRIORITY_ORDER, PRIORITY_SHAPE_CLASS } from "../lib/timelineView.js";
import type { Scale } from "../lib/timeScale.js";

// Extracted out of TimelineView.tsx (#1099 god-module gate: that file crossed the 1000-line
// hard ceiling once R1/P2-20/P2-13 landed) — a self-contained, prop-driven toolbar with no
// dependency on the rest of the view beyond these types.

const SCALES: readonly Scale[] = ["day", "week", "month", "quarter"];
const SCALE_LABELS: Record<Scale, string> = { day: "Day", week: "Week", month: "Month", quarter: "Quarter" };

export function TimelineToolbar({
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
            aria-pressed={s === scale}
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
        <button onClick={() => onZoom(1 / 1.25)} className={navBtn} title="Zoom out" aria-label="Zoom out">−</button>
        <button onClick={() => onZoom(1.25)} className={navBtn} title="Zoom in" aria-label="Zoom in">+</button>
      </div>
      <div className="flex items-center gap-1">
        {Object.entries(TYPE_COLORS).map(([type, cls]) => {
          const isActive = activeTypes.has(type);
          return (
            <button
              key={type}
              onClick={() => onToggleType(type)}
              title={isActive ? `Hide ${type}s` : `Show ${type}s`}
              aria-pressed={isActive}
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

      {/*
        #1088 P2-7: a bar's priority dot, dashed border and the red "today" line were each
        readable only by hovering (the dot's own `title`, the bar's own `title`) or by
        already knowing the convention — nothing on the toolbar named what a colour or a
        marker meant. This legend states the one thing a bar's OWN chrome cannot make
        discoverable without hovering: the priority colour scale (type colour/border is
        already legend-shaped via the type filter chips above, which double as their own
        key).
      */}
      <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500 border-l border-gray-200 dark:border-gray-700 pl-3">
        <span>Priority</span>
        {PRIORITY_ORDER.map((p) => (
          <span key={p} className="flex items-center gap-1" title={`Priority: ${p}`}>
            {/*
              #1099 P2-10: priority used to be color alone — a sighted reader who can't tell
              the four hues apart (low vision, color blindness, a grayscale screenshot) had no
              other cue. Each priority now also has a distinct shape (see
              `PRIORITY_SHAPE_CLASS`), mirrored here in the legend and on every bar's dot.
            */}
            <span className={`shrink-0 ${PRIORITY_SHAPE_CLASS[p] ?? PRIORITY_SHAPE_CLASS.medium}`} style={{ backgroundColor: PRIORITY_COLORS[p] }} />
            <span className="capitalize">{p}</span>
          </span>
        ))}
        <span className="flex items-center gap-1 ml-1" title="Due date is before the created date">
          <span className="text-red-500 dark:text-red-400 font-bold">⚠</span>
          <span>Invalid due date</span>
        </span>
        {/*
          #1099 P2-7: the priority/invalid-due-date keys explain a bar's CHROME, but nothing
          said what the bar's own extent means, or what the row shading and the red vertical
          line are — both were previously only guessable. This closes that gap without
          enumerating every possible status color (which would drift from `STATUS_BG` and
          double the maintenance surface for little extra clarity).
        */}
        <span className="flex items-center gap-1 ml-1 border-l border-gray-200 dark:border-gray-700 pl-3" title="A bar spans from when the issue was created to when it was completed, or to now if it's still open">
          <span className="w-4 h-1.5 rounded-sm bg-slate-300 dark:bg-slate-600 shrink-0" />
          <span>Bar: created → done/now</span>
        </span>
        <span className="flex items-center gap-1" title="Today">
          <span className="w-0.5 h-3 bg-red-400/60 dark:bg-red-500/50 shrink-0" />
          <span>Today</span>
        </span>
      </div>
    </div>
  );
}
