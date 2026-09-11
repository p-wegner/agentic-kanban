import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  TYPE_COLORS,
  PRIORITY_COLORS,
  PRIORITY_ORDER,
} from "../lib/timelineView.js";
import { useDismissable } from "../hooks/useDismissable.js";
import type { Scale } from "../lib/timeScale.js";

// Toolbar half of TimelineView, split out to keep TimelineView.tsx under the god-module line
// ceiling (#1100) — this file owns the scale switcher, nav/zoom controls, the type chips, the
// priority/tag filter popover, and the priority legend. No state here is shared with the lane
// rendering in TimelineView.tsx beyond what is passed in as props.

export const SCALES: readonly Scale[] = ["day", "week", "month", "quarter"];
export const SCALE_LABELS: Record<Scale, string> = { day: "Day", week: "Week", month: "Month", quarter: "Quarter" };

/**
 * Priority + tag filter popover (P2-15 remainder, #1100). Split out from the always-visible
 * type chips because both are open-ended enough (priority has 4 values, tags an unbounded,
 * per-project count) that inlining them as chips the way types are would crowd the toolbar
 * whenever a project has more than a couple of tags — the same reasoning `BoardFilterMenu`
 * already applies board-wide.
 */
function TimelineFilterMenu({
  availableTags, activePriorities, onTogglePriority, activeTagIds, onToggleTag,
}: {
  availableTags: { id: string; name: string; color?: string | null }[];
  activePriorities: Set<string>;
  onTogglePriority: (priority: string) => void;
  activeTagIds: Set<string>;
  onToggleTag: (tagId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismissable(ref, open, useCallback(() => setOpen(false), []));
  const activeCount = activePriorities.size + activeTagIds.size;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Filter by priority or tag"
        className={`flex items-center gap-1.5 px-2 h-6 text-xs rounded border transition-colors ${
          activeCount > 0
            ? "bg-brand-50 dark:bg-brand-950/30 border-brand-300 dark:border-brand-700 text-brand-700 dark:text-brand-400"
            : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
        }`}
      >
        Priority/Tags
        {activeCount > 0 && (
          <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-brand-600 text-white px-1 text-[10px] font-semibold leading-none">
            {activeCount}
          </span>
        )}
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-30 mt-1 w-56 rounded-md border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-900 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Priority</label>
            <div className="flex items-center gap-1 flex-wrap">
              {PRIORITY_ORDER.map((p) => {
                const isActive = activePriorities.has(p);
                return (
                  <button
                    key={p}
                    onClick={() => onTogglePriority(p)}
                    aria-pressed={isActive}
                    title={`Filter by priority: ${p}`}
                    className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border transition-colors capitalize ${
                      isActive
                        ? "border-brand-600 bg-brand-600 text-white"
                        : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
                    }`}
                  >
                    <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: PRIORITY_COLORS[p] }} />
                    {p}
                  </button>
                );
              })}
            </div>
          </div>
          {availableTags.length > 0 && (
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Tags</label>
              <div className="flex items-center gap-1 flex-wrap">
                {availableTags.map((tag) => {
                  const isActive = activeTagIds.has(tag.id);
                  return (
                    <button
                      key={tag.id}
                      onClick={() => onToggleTag(tag.id)}
                      aria-pressed={isActive}
                      title={`Filter by tag: ${tag.name}`}
                      className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border transition-colors ${
                        isActive
                          ? "border-brand-600 bg-brand-600 text-white"
                          : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
                      }`}
                    >
                      {tag.color && (
                        <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                      )}
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TimelineToolbar({
  issueCount, laneCount, showCompleted, setShowCompleted, scale, onSetScale, onStep, onToday, onFitAll, onZoom, activeTypes, onToggleType,
  availableTags, activePriorities, onTogglePriority, activeTagIds, onToggleTag,
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
  availableTags: { id: string; name: string; color?: string | null }[];
  activePriorities: Set<string>;
  onTogglePriority: (priority: string) => void;
  activeTagIds: Set<string>;
  onToggleTag: (tagId: string) => void;
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

      <TimelineFilterMenu
        availableTags={availableTags}
        activePriorities={activePriorities}
        onTogglePriority={onTogglePriority}
        activeTagIds={activeTagIds}
        onToggleTag={onToggleTag}
      />

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
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: PRIORITY_COLORS[p] }} />
            <span className="capitalize">{p}</span>
          </span>
        ))}
        <span className="flex items-center gap-1 ml-1" title="Due date is before the created date">
          <span className="text-red-500 dark:text-red-400 font-bold">⚠</span>
          <span>Invalid due date</span>
        </span>
      </div>
    </div>
  );
}
