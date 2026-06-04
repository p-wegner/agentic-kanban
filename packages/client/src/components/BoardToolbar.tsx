import { useState, useRef, useEffect } from "react";
import { MonitorPopover, type MonitorStatus } from "./MonitorPopover.js";
import { useOrchestrator } from "../hooks/useOrchestrator.js";
import { apiFetch } from "../lib/api.js";
import { VoiceInboxButton } from "./VoiceInboxButton.js";
import { ProjectScriptsMenu } from "./ProjectScriptsMenu.js";
import { ExportImportMenu } from "./ExportImportMenu.js";
import { PRIMARY_VIEWS, SECONDARY_VIEWS, VIEW_REGISTRY } from "../lib/viewRegistry.js";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import type { ProjectTag } from "./IssueCard.js";
import type { CardDensity } from "../hooks/useBoardPreferences.js";
import type { MilestoneResponse } from "@agentic-kanban/shared";
import { PRIORITY_META } from "../lib/chartColors.js";

// Re-exported from the canonical view registry (#116). Kept here for back-compat
// with the many components that import `ViewMode` from BoardToolbar.
export type { ViewMode } from "../lib/viewRegistry.js";
import type { ViewMode } from "../lib/viewRegistry.js";

const ACTIVE_DEFAULT = "bg-brand-600 text-white hover:bg-brand-700";
const INACTIVE = "text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-700";
const BOARD_ACTIVITY_STATUS_ORDER = ["In Progress", "In Review", "AI Reviewed", "Todo"];

interface AgingHeatmapLegendProps {
  warmDays: number;
  hotDays: number;
  onChange: (warm: number, hot: number) => void;
}

function AgingHeatmapLegend({ warmDays, hotDays, onChange }: AgingHeatmapLegendProps) {
  const [warmInput, setWarmInput] = useState(String(warmDays));
  const [hotInput, setHotInput] = useState(String(hotDays));

  useEffect(() => { setWarmInput(String(warmDays)); }, [warmDays]);
  useEffect(() => { setHotInput(String(hotDays)); }, [hotDays]);

  function commitWarm(raw: string) {
    const v = parseInt(raw, 10);
    if (!isNaN(v) && v >= 1 && v < hotDays) {
      onChange(v, hotDays);
    } else {
      setWarmInput(String(warmDays));
    }
  }

  function commitHot(raw: string) {
    const v = parseInt(raw, 10);
    if (!isNaN(v) && v > warmDays) {
      onChange(warmDays, v);
    } else {
      setHotInput(String(hotDays));
    }
  }

  return (
    <div className="flex items-center gap-3 px-1 py-1 flex-wrap" aria-label="Card aging heatmap legend">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint dark:text-gray-500">Aging:</span>
      <span className="flex items-center gap-1">
        <span aria-hidden="true" className="inline-block h-3 w-3 rounded-sm bg-surface-raised dark:bg-surface-raised-dark border border-black/[0.07] dark:border-white/10" />
        <span className="text-[10px] text-ink-soft dark:text-gray-400">Fresh</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: "rgba(251,191,36,0.35)" }} />
        <span className="text-[10px] text-ink-soft dark:text-gray-400">Warm ≥</span>
        <input
          type="number"
          min={1}
          max={hotDays - 1}
          value={warmInput}
          onChange={(e) => setWarmInput(e.target.value)}
          onBlur={(e) => commitWarm(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commitWarm((e.target as HTMLInputElement).value); }}
          className="w-10 text-[10px] rounded px-1 py-0.5 border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-ink dark:text-gray-100 outline-none"
          title="Warm threshold (days)"
        />
        <span className="text-[10px] text-ink-faint dark:text-gray-500">d</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: "rgba(239,68,68,0.3)" }} />
        <span className="text-[10px] text-ink-soft dark:text-gray-400">Hot ≥</span>
        <input
          type="number"
          min={warmDays + 1}
          value={hotInput}
          onChange={(e) => setHotInput(e.target.value)}
          onBlur={(e) => commitHot(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commitHot((e.target as HTMLInputElement).value); }}
          className="w-10 text-[10px] rounded px-1 py-0.5 border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-ink dark:text-gray-100 outline-none"
          title="Hot threshold (days)"
        />
        <span className="text-[10px] text-ink-faint dark:text-gray-500">d</span>
      </span>
    </div>
  );
}

interface BoardToolbarProps {
  activeColumns: StatusWithIssues[];
  onShowTimeReport?: () => void;
  focusMode?: boolean;
  onFocusModeChange?: (v: boolean) => void;
  onShowQuickTasks: () => void;
  autoMonitor: boolean;
  monitorRunning: boolean;
  onMonitorRunNow: () => Promise<void>;
  monitorStatus: MonitorStatus | null;
  onToggleAutoMonitor: () => void;
  autoMonitorInterval: string;
  onIntervalChange: (v: string) => void;
  nudgeAutoStart: boolean;
  onNudgeAutoStartChange: (v: boolean) => void;
  nudgeWipLimit: string;
  onNudgeWipLimitChange: (v: string) => void;
  columns: StatusWithIssues[];
  onOpenWorkspace: (workspaceId: string, issueId: string) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  butlerBadgeCount?: number;
  projectId: string | null;
  onVoiceIssueCreated?: () => void;
  onShowMergeQueue?: () => void;
  mergeQueueCount?: number;
  onShowRunQueueForecast?: () => void;
  runQueueOpenSlots?: number;
  onShowLiveActivityTicker?: () => void;
  liveActivityCount?: number;
  onViewAllHealthEvents?: () => void;
  cardDensity?: CardDensity;
  onCardDensityChange?: (v: CardDensity) => void;
  visibilityColumns?: StatusWithIssues[];
  hiddenColumns?: Set<string>;
  onHiddenColumnsChange?: (statusName: string, hidden: boolean) => void;
  milestones?: MilestoneResponse[];
  activeMilestoneId?: string | null;
  onMilestoneFilterChange?: (milestoneId: string | null) => void;
  issueTypeFilter?: string | null;
  onIssueTypeFilterChange?: (type: string | null) => void;
  showPriorityLegend?: boolean;
  onShowPriorityLegendChange?: (v: boolean) => void;
  showCardAgingHeatmap?: boolean;
  onShowCardAgingHeatmapChange?: (v: boolean) => void;
  agingWarmDays?: number;
  agingHotDays?: number;
  onAgingThresholdsChange?: (warm: number, hot: number) => void;
  swimlaneDimension?: "none" | "priority" | "tag";
  onSwimlaneChange?: (v: "none" | "priority" | "tag") => void;
  tags?: ProjectTag[];
  activeTagIds?: Set<string>;
  onTagFilterToggle?: (tagId: string) => void;
  onClearTagFilter?: () => void;
}

export function BoardToolbar({
  activeColumns,
  onShowTimeReport,
  focusMode = false,
  onFocusModeChange,
  onShowQuickTasks,
  autoMonitor,
  monitorRunning,
  onMonitorRunNow,
  monitorStatus,
  onToggleAutoMonitor,
  autoMonitorInterval,
  onIntervalChange,
  nudgeAutoStart,
  onNudgeAutoStartChange,
  nudgeWipLimit,
  onNudgeWipLimitChange,
  columns,
  onOpenWorkspace,
  viewMode,
  onViewModeChange,
  butlerBadgeCount = 0,
  projectId,
  onVoiceIssueCreated,
  onShowMergeQueue,
  mergeQueueCount = 0,
  onShowRunQueueForecast,
  runQueueOpenSlots = 0,
  onShowLiveActivityTicker,
  liveActivityCount = 0,
  onViewAllHealthEvents,
  cardDensity = "comfortable",
  onCardDensityChange,
  visibilityColumns,
  hiddenColumns,
  onHiddenColumnsChange,
  milestones = [],
  activeMilestoneId = null,
  onMilestoneFilterChange,
  issueTypeFilter = null,
  onIssueTypeFilterChange,
  showPriorityLegend = false,
  onShowPriorityLegendChange,
  showCardAgingHeatmap = false,
  onShowCardAgingHeatmapChange,
  agingWarmDays = 3,
  agingHotDays = 7,
  onAgingThresholdsChange,
  swimlaneDimension = "none",
  onSwimlaneChange,
  tags,
  activeTagIds,
  onTagFilterToggle,
  onClearTagFilter,
}: BoardToolbarProps) {
  const [showMonitorPopover, setShowMonitorPopover] = useState(false);
  const [showColumnVisibility, setShowColumnVisibility] = useState(false);
  const columnVisibilityRef = useRef<HTMLDivElement>(null);
  const [showMoreViews, setShowMoreViews] = useState(false);
  const moreViewsRef = useRef<HTMLDivElement>(null);
  // Below sm the action cluster (Tasks/Scripts/Queue/Capacity/Voice/Monitor) is
  // hidden behind a ⋯ toggle so the default phone view is just pulse + view + filter.
  const [showActions, setShowActions] = useState(false);
  // Below sm the 7-tab view switcher collapses to a single dropdown listing ALL views
  // (it overflowed/clipped on phone widths). Tabs + "More" still render on sm+.
  const [showAllViews, setShowAllViews] = useState(false);
  const allViewsRef = useRef<HTMLDivElement>(null);
  const activeView = VIEW_REGISTRY.find((v) => v.id === viewMode);
  const boardActivitySummary = formatBoardActivitySummary(activeColumns);
  const hasMonitorWarnings = (monitorStatus?.warnings?.length ?? 0) > 0;
  // Dogfooding orchestrator loop status + opt-in notifications (hidden when no loop).
  const { status: orchestrator, notify: orchestratorNotify, setNotify: setOrchestratorNotify } = useOrchestrator(projectId);
  // Monitor Butler enabled state (loaded from prefs).
  const [monitorButlerEnabled, setMonitorButlerEnabled] = useState(false);
  const [monitorButlerInterval, setMonitorButlerInterval] = useState(15);
  useEffect(() => {
    apiFetch<Record<string, string>>("/api/preferences/settings")
      .then((s) => {
        setMonitorButlerEnabled(s.monitor_butler_enabled === "true");
        const raw = parseInt(s.monitor_butler_interval_min ?? "15", 10);
        setMonitorButlerInterval(isNaN(raw) ? 15 : raw);
      })
      .catch(() => {});
  }, []);

  // Close the "More" views dropdown on outside click or Escape.
  useEffect(() => {
    if (!showMoreViews) return;
    function handleClick(e: MouseEvent) {
      if (moreViewsRef.current && !moreViewsRef.current.contains(e.target as Node)) {
        setShowMoreViews(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setShowMoreViews(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [showMoreViews]);

  // Same outside-click/Escape handling for the mobile all-views dropdown.
  useEffect(() => {
    if (!showAllViews) return;
    function handleClick(e: MouseEvent) {
      if (allViewsRef.current && !allViewsRef.current.contains(e.target as Node)) {
        setShowAllViews(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setShowAllViews(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [showAllViews]);

  useEffect(() => {
    if (!showColumnVisibility) return;
    function handleClick(e: MouseEvent) {
      if (columnVisibilityRef.current && !columnVisibilityRef.current.contains(e.target as Node)) {
        setShowColumnVisibility(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setShowColumnVisibility(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [showColumnVisibility]);

  const activeSecondaryView = SECONDARY_VIEWS.find((v) => v.id === viewMode);

  return (
    <>
    <div className="flex items-start gap-2 flex-wrap">
      {/* < sm : toggle to reveal the action cluster (collapsed by default for room) */}
      <button
        onClick={() => setShowActions((v) => !v)}
        aria-haspopup="true"
        aria-expanded={showActions}
        title="Board actions"
        className={`sm:hidden shrink-0 flex items-center justify-center w-8 h-8 rounded-md border transition-colors ${
          showActions
            ? "bg-surface-sunken dark:bg-gray-800 border-black/[0.07] dark:border-white/10 text-ink dark:text-gray-200"
            : "bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
        }`}
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
        </svg>
      </button>
      <div className={`${showActions ? "flex" : "hidden"} sm:flex items-start gap-2 flex-wrap`}>
      {onFocusModeChange && (
        <button
          onClick={() => onFocusModeChange(!focusMode)}
          title={focusMode ? "Focus mode on — showing only in-flight issues. Click to show all." : "Focus mode — show only issues with an active or fixing workspace (f)"}
          aria-pressed={focusMode}
          className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${
            focusMode
              ? "bg-brand-600 text-white border-brand-600 hover:bg-brand-700"
              : "bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
          }`}
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="3" />
            <path strokeLinecap="round" d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
          </svg>
          <span className="hidden sm:inline">Focus</span>
        </button>
      )}
      {onCardDensityChange && (
        <button
          onClick={() => onCardDensityChange(cardDensity === "compact" ? "comfortable" : "compact")}
          title={cardDensity === "compact" ? "Compact density — click for comfortable" : "Comfortable density — click for compact"}
          aria-pressed={cardDensity === "compact"}
          className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${
            cardDensity === "compact"
              ? "bg-brand-600 text-white border-brand-600 hover:bg-brand-700"
              : "bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
          }`}
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
          </svg>
          <span className="hidden sm:inline">Compact</span>
        </button>
      )}
      {onShowPriorityLegendChange && (
        <button
          onClick={() => onShowPriorityLegendChange(!showPriorityLegend)}
          title={showPriorityLegend ? "Hide priority legend" : "Show priority color legend"}
          aria-pressed={showPriorityLegend}
          className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${
            showPriorityLegend
              ? "bg-brand-600 text-white border-brand-600 hover:bg-brand-700"
              : "bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
          }`}
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="3" width="5" height="5" rx="1" />
            <rect x="3" y="10" width="5" height="5" rx="1" />
            <rect x="3" y="17" width="5" height="5" rx="1" />
            <line x1="11" y1="5.5" x2="21" y2="5.5" />
            <line x1="11" y1="12.5" x2="21" y2="12.5" />
            <line x1="11" y1="19.5" x2="21" y2="19.5" />
          </svg>
          <span className="hidden sm:inline">Priority</span>
        </button>
      )}
      {onShowCardAgingHeatmapChange && (
        <button
          onClick={() => onShowCardAgingHeatmapChange(!showCardAgingHeatmap)}
          title={showCardAgingHeatmap ? "Hide card aging heatmap" : "Tint cards by time in column (aging heatmap)"}
          aria-pressed={showCardAgingHeatmap}
          className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${
            showCardAgingHeatmap
              ? "bg-brand-600 text-white border-brand-600 hover:bg-brand-700"
              : "bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
          }`}
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="hidden sm:inline">Aging</span>
        </button>
      )}
      {onHiddenColumnsChange && visibilityColumns && visibilityColumns.length > 0 && (
        <div className="relative shrink-0" ref={columnVisibilityRef}>
          <button
            onClick={() => setShowColumnVisibility((v) => !v)}
            aria-haspopup="true"
            aria-expanded={showColumnVisibility}
            title="Toggle column visibility"
            className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${
              hiddenColumns && hiddenColumns.size > 0
                ? "bg-brand-600 text-white border-brand-600 hover:bg-brand-700"
                : "bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
            }`}
          >
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 4.5v15m6-15v15M3 9h18M3 15h18" />
            </svg>
            <span className="hidden sm:inline">Columns</span>
          </button>
          {showColumnVisibility && (
            <div className="absolute left-0 top-full z-30 mt-1 w-48 rounded-md border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900">
              <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint dark:text-gray-500">
                Show / hide columns
              </p>
              {visibilityColumns.map((col) => {
                const isHidden = hiddenColumns?.has(col.name) ?? false;
                const visibleCount = visibilityColumns.filter((c) => !(hiddenColumns?.has(c.name) ?? false)).length;
                const isLastVisible = !isHidden && visibleCount <= 1;
                return (
                  <label
                    key={col.id}
                    className={`flex items-center gap-2 rounded px-2 py-1 text-xs transition-colors ${isLastVisible ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-surface-sunken dark:hover:bg-gray-800"}`}
                    title={isLastVisible ? "At least one column must remain visible" : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={!isHidden}
                      disabled={isLastVisible}
                      onChange={(e) => onHiddenColumnsChange(col.name, !e.target.checked)}
                      className="h-3 w-3 rounded border-gray-300 text-brand-600 focus:ring-brand-500 disabled:cursor-not-allowed"
                    />
                    <span className="flex-1 text-ink dark:text-gray-200">{col.name}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}
      {onMilestoneFilterChange && milestones.length > 0 && (
        <div className="relative shrink-0">
          <select
            value={activeMilestoneId ?? ""}
            onChange={(e) => onMilestoneFilterChange(e.target.value || null)}
            title="Filter by milestone"
            className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors appearance-none pr-6 cursor-pointer ${
              activeMilestoneId
                ? "bg-brand-600 text-white border-brand-600 hover:bg-brand-700"
                : "bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
            }`}
          >
            <option value="">Milestone</option>
            {milestones.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <svg className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
          </svg>
        </div>
      )}
      {onIssueTypeFilterChange && (
        <div className="flex items-center gap-0 border border-black/[0.07] dark:border-white/10 rounded-md p-0.5 bg-surface-raised dark:bg-surface-raised-dark shrink-0">
          {(["All", "feature", "bug", "chore"] as const).map((type) => {
            const label = type === "All" ? "All" : type === "chore" ? "Quality" : type.charAt(0).toUpperCase() + type.slice(1);
            const isActive = type === "All" ? issueTypeFilter === null : issueTypeFilter === type;
            return (
              <button
                key={type}
                onClick={() => onIssueTypeFilterChange(type === "All" ? null : type)}
                className={`px-2 py-0.5 text-xs rounded transition-colors ${
                  isActive
                    ? "bg-brand-600 text-white"
                    : "text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-700"
                }`}
                title={`Show ${label} issues only`}
                aria-pressed={isActive}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      {onSwimlaneChange && (
        <div className="flex items-center gap-0 border border-black/[0.07] dark:border-white/10 rounded-md p-0.5 bg-surface-raised dark:bg-surface-raised-dark shrink-0">
          {(["none", "priority", "tag"] as const).map((dim) => {
            const label = dim === "none" ? "None" : dim === "priority" ? "Priority" : "Tag";
            const isActive = swimlaneDimension === dim;
            return (
              <button
                key={dim}
                onClick={() => onSwimlaneChange(dim)}
                className={`px-2 py-0.5 text-xs rounded transition-colors ${
                  isActive
                    ? "bg-brand-600 text-white"
                    : "text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-700"
                }`}
                title={`Group by ${label}`}
                aria-pressed={isActive}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      <button
        onClick={onShowQuickTasks}
        title="Quick Tasks - run a skill directly on the current checkout (q)"
        className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
      >
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <polygon points="5,3 19,12 5,21" />
        </svg>
        <span className="hidden sm:inline">Tasks</span>
      </button>
      <ProjectScriptsMenu projectId={projectId} />
      <ExportImportMenu projectId={projectId} />
      {onShowTimeReport && (
        <button
          onClick={onShowTimeReport}
          title="Time Report — aggregate logged time by issue and day"
          className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="9" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 3" />
          </svg>
          <span className="hidden sm:inline">Time</span>
        </button>
      )}
      {onShowMergeQueue && (
        <button
          onClick={onShowMergeQueue}
          title="Merge Queue - review In Review workspaces ordered by conflict risk"
          className="relative shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h18M3 12h12M3 17h6" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l3 3-3 3" />
          </svg>
          <span className="hidden sm:inline">Queue</span>
          {mergeQueueCount > 0 && (
            <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-brand-500 text-white text-[10px] font-semibold leading-none">
              {mergeQueueCount > 99 ? "99+" : mergeQueueCount}
            </span>
          )}
        </button>
      )}
      {onShowRunQueueForecast && (
        <button
          onClick={onShowRunQueueForecast}
          title="Run Queue Forecast - view active-agent capacity and next likely starts"
          className="relative shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 18V6m4 12V9m4 9v-5m4 5V4m4 14v-7" />
          </svg>
          <span className="hidden sm:inline">Capacity</span>
          {runQueueOpenSlots > 0 && (
            <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-sky-500 text-white text-[10px] font-semibold leading-none">
              {runQueueOpenSlots > 99 ? "99+" : runQueueOpenSlots}
            </span>
          )}
        </button>
      )}
      {onShowLiveActivityTicker && (
        <button
          onClick={onShowLiveActivityTicker}
          title="Live Activity — compact stream of running agent output (l)"
          className="relative shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 17l6-6-6-6" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 17l6-6" strokeOpacity={0.4} />
          </svg>
          <span className="hidden sm:inline">Pulse</span>
          {liveActivityCount > 0 && (
            <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-emerald-500 text-white text-[10px] font-semibold leading-none">
              {liveActivityCount > 99 ? "99+" : liveActivityCount}
            </span>
          )}
        </button>
      )}
      <VoiceInboxButton projectId={projectId} onIssueCreated={onVoiceIssueCreated} />
      <div className="relative shrink-0 flex items-center gap-0.5">
        <button
          onClick={() => setShowMonitorPopover(v => !v)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${
            hasMonitorWarnings
              ? "bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900"
              : (autoMonitor || monitorButlerEnabled || (orchestrator?.available && orchestrator.alive))
                ? "bg-accent-50 dark:bg-accent-950 border-accent-200 dark:border-accent-800 text-accent-700 hover:bg-accent-100 dark:hover:bg-accent-900"
                : "bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
          }`}
          title={
            hasMonitorWarnings
              ? "Board monitor warning - dirty main checkout"
              : buildMonitorTitle(autoMonitor, monitorButlerEnabled, orchestrator?.available && orchestrator.alive)
          }
        >
          {hasMonitorWarnings ? (
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            </svg>
          ) : (
            <ActiveMonitorDots
              autoMonitor={autoMonitor}
              butlerEnabled={monitorButlerEnabled}
              orchestratorAlive={orchestrator?.available && orchestrator.alive}
            />
          )}
          <span className="hidden sm:inline">Monitor</span>
          <ActiveMonitorBadge
            autoMonitor={autoMonitor}
            butlerEnabled={monitorButlerEnabled}
            orchestratorAlive={orchestrator?.available && orchestrator.alive}
          />
        </button>
        <button
          onClick={onMonitorRunNow}
          disabled={monitorRunning}
          className="flex items-center justify-center w-6 h-6 rounded border border-black/[0.07] dark:border-white/10 bg-surface-raised dark:bg-surface-raised-dark text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800 hover:text-ink dark:hover:text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Run monitor now and reset timer"
        >
          {monitorRunning
            ? <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
            : <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z"/></svg>
          }
        </button>
        {showMonitorPopover && (
          <MonitorPopover
            status={monitorStatus}
            onClose={() => setShowMonitorPopover(false)}
            onOpenWorkspace={(workspaceId, issueId) => {
              onOpenWorkspace(workspaceId, issueId);
              setShowMonitorPopover(false);
            }}
            columns={columns}
            onRunNow={onMonitorRunNow}
            autoMonitor={autoMonitor}
            onToggle={onToggleAutoMonitor}
            interval={autoMonitorInterval}
            onIntervalChange={onIntervalChange}
            nudgeAutoStart={nudgeAutoStart}
            onNudgeAutoStartChange={onNudgeAutoStartChange}
            nudgeWipLimit={nudgeWipLimit}
            onNudgeWipLimitChange={onNudgeWipLimitChange}
            projectId={projectId}
            orchestrator={orchestrator}
            orchestratorNotify={orchestratorNotify}
            onOrchestratorNotifyChange={setOrchestratorNotify}
            monitorButlerEnabled={monitorButlerEnabled}
            monitorButlerInterval={monitorButlerInterval}
            onViewAllHealthEvents={onViewAllHealthEvents ? () => {
              setShowMonitorPopover(false);
              onViewAllHealthEvents();
            } : undefined}
          />
        )}
      </div>
      </div>
      {/* < sm : a single dropdown listing ALL views (the tab strip clips on phones). */}
      <div className="relative shrink-0 sm:hidden" ref={allViewsRef}>
        <button
          onClick={() => setShowAllViews((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={showAllViews}
          className={`relative flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${activeView?.activeClass ?? ACTIVE_DEFAULT}`}
          title={activeView ? `${activeView.tooltip} — switch view` : "Switch view"}
        >
          {activeView?.icon}
          <span>{activeView?.toolbarLabel ?? "View"}</span>
          {butlerBadgeCount > 0 && (
            <span className="ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-none text-white" aria-label={`${butlerBadgeCount} pending agent questions`}>
              {butlerBadgeCount > 99 ? "99+" : butlerBadgeCount}
            </span>
          )}
          <svg className={`h-3 w-3 transition-transform ${showAllViews ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {showAllViews && (
          <div role="menu" className="absolute left-0 top-full z-30 mt-1 max-h-[70vh] w-52 overflow-y-auto rounded-md border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">
            {VIEW_REGISTRY.map((view) => {
              const isActive = viewMode === view.id;
              const activeClass = view.activeClass ?? ACTIVE_DEFAULT;
              const showBadge = view.badge === "butler" && butlerBadgeCount > 0;
              return (
                <button
                  key={view.id}
                  role="menuitem"
                  onClick={() => {
                    onViewModeChange(view.id);
                    setShowAllViews(false);
                  }}
                  className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs transition-colors ${isActive ? activeClass : INACTIVE}`}
                  title={view.tooltip}
                >
                  {view.icon}
                  <span className="flex-1">{view.label}</span>
                  {showBadge && (
                    <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-none text-white">
                      {butlerBadgeCount > 99 ? "99+" : butlerBadgeCount}
                    </span>
                  )}
                  {view.shortcut && <kbd className="font-mono text-[10px] opacity-60">{view.shortcut}</kbd>}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="hidden sm:flex items-center gap-1 border border-black/[0.07] dark:border-white/10 rounded-md p-0.5 bg-surface-raised dark:bg-surface-raised-dark shrink-0">
        {PRIMARY_VIEWS.map((view) => {
          const isActive = viewMode === view.id;
          const activeClass = view.activeClass ?? ACTIVE_DEFAULT;
          const showBadge = view.badge === "butler" && butlerBadgeCount > 0;
          const shortcutHint = view.shortcut ? ` (${view.shortcut})` : "";
          const title = showBadge
            ? `${view.tooltip}${shortcutHint} — ${butlerBadgeCount} pending agent question${butlerBadgeCount === 1 ? "" : "s"}`
            : `${view.tooltip}${shortcutHint}`;
          return (
            <button
              key={view.id}
              onClick={() => onViewModeChange(view.id)}
              className={`relative px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${isActive ? activeClass : INACTIVE}`}
              title={title}
            >
              {view.icon}
              {view.toolbarLabel}
              {view.id === "kanban" && boardActivitySummary && (
                <span
                  className={`hidden md:inline max-w-[260px] truncate rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
                    isActive
                      ? "bg-white/20 text-white"
                      : "bg-surface-sunken dark:bg-gray-800 text-ink-soft dark:text-gray-400"
                  }`}
                  title={boardActivitySummary}
                >
                  {boardActivitySummary}
                </span>
              )}
              {showBadge && (
                <span
                  className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-amber-500 text-white text-[10px] font-semibold leading-none"
                  aria-label={`${butlerBadgeCount} pending agent questions`}
                >
                  {butlerBadgeCount > 99 ? "99+" : butlerBadgeCount}
                </span>
              )}
            </button>
          );
        })}
        {SECONDARY_VIEWS.length > 0 && (
          <div className="relative" ref={moreViewsRef}>
            <button
              onClick={() => setShowMoreViews((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={showMoreViews}
              className={`relative px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${activeSecondaryView ? (activeSecondaryView.activeClass ?? ACTIVE_DEFAULT) : INACTIVE}`}
              title={
                activeSecondaryView
                  ? `${activeSecondaryView.tooltip} — more analytics views`
                  : "More views — metrics, insights, swimlane and more"
              }
            >
              {activeSecondaryView ? (
                <>
                  {activeSecondaryView.icon}
                  {activeSecondaryView.toolbarLabel}
                </>
              ) : (
                "More"
              )}
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {showMoreViews && (
              <div
                role="menu"
                className="absolute top-full right-0 mt-1 w-48 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-20 p-1"
              >
                {SECONDARY_VIEWS.map((view) => {
                  const isActive = viewMode === view.id;
                  const activeClass = view.activeClass ?? ACTIVE_DEFAULT;
                  const shortcutHint = view.shortcut ? ` (${view.shortcut})` : "";
                  return (
                    <button
                      key={view.id}
                      role="menuitem"
                      onClick={() => {
                        onViewModeChange(view.id);
                        setShowMoreViews(false);
                      }}
                      className={`w-full text-left px-2.5 py-1.5 text-xs rounded flex items-center gap-2 transition-colors ${isActive ? activeClass : INACTIVE}`}
                      title={`${view.tooltip}${shortcutHint}`}
                    >
                      {view.icon}
                      <span className="flex-1">{view.label}</span>
                      {view.shortcut && (
                        <kbd className="text-[10px] font-mono opacity-60">{view.shortcut}</kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
    {showPriorityLegend && (
      <div className="flex items-center gap-3 px-1 py-1 flex-wrap" aria-label="Priority color legend">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint dark:text-gray-500">Priority:</span>
        {PRIORITY_META.map((p) => (
          <span key={p.key} className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-[3px] rounded-full flex-shrink-0"
              style={{ backgroundColor: p.color }}
            />
            <span className="text-[10px] text-ink-soft dark:text-gray-400">{p.label}</span>
          </span>
        ))}
      </div>
    )}
    {showCardAgingHeatmap && onAgingThresholdsChange && (
      <AgingHeatmapLegend
        warmDays={agingWarmDays}
        hotDays={agingHotDays}
        onChange={onAgingThresholdsChange}
      />
    )}
    {onTagFilterToggle && tags && tags.length > 0 && (
      <div className="flex items-center gap-1.5 px-1 py-1 flex-wrap" aria-label="Filter by tag">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint dark:text-gray-500 shrink-0">Tags:</span>
        {tags.map((tag) => {
          const isActive = activeTagIds?.has(tag.id) ?? false;
          return (
            <button
              key={tag.id}
              onClick={() => onTagFilterToggle(tag.id)}
              aria-pressed={isActive}
              title={`Filter by tag: ${tag.name}`}
              className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border transition-colors ${
                isActive
                  ? "border-brand-600 bg-brand-600 text-white hover:bg-brand-700"
                  : "border-black/[0.07] dark:border-white/10 bg-surface-raised dark:bg-surface-raised-dark text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-700"
              }`}
            >
              {tag.color && (
                <span
                  aria-hidden="true"
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: tag.color }}
                />
              )}
              {tag.name}
            </button>
          );
        })}
        {(activeTagIds?.size ?? 0) > 0 && (
          <button
            onClick={onClearTagFilter}
            title="Clear tag filter"
            className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border border-black/[0.07] dark:border-white/10 bg-surface-raised dark:bg-surface-raised-dark text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-700 transition-colors"
          >
            Clear
          </button>
        )}
      </div>
    )}
    </>
  );
}

function buildMonitorTitle(autoMonitor: boolean, butlerEnabled: boolean, orchestratorAlive: boolean | undefined): string {
  const active: string[] = [];
  if (orchestratorAlive) active.push("Orchestrator loop");
  if (butlerEnabled) active.push("Monitor Butler");
  if (autoMonitor) active.push("Auto-monitor");
  if (active.length === 0) return "Board monitor - click to configure";
  return `Active: ${active.join(", ")} — click for details`;
}

function ActiveMonitorDots({
  autoMonitor,
  butlerEnabled,
  orchestratorAlive,
}: { autoMonitor: boolean; butlerEnabled: boolean; orchestratorAlive: boolean | undefined }) {
  if (!autoMonitor && !butlerEnabled && !orchestratorAlive) return null;
  return (
    <span className="flex items-center gap-0.5">
      {orchestratorAlive && <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" title="Orchestrator loop" />}
      {butlerEnabled && <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" title="Monitor Butler" />}
      {autoMonitor && <span className="w-1.5 h-1.5 rounded-full bg-accent-500 animate-pulse" title="Auto-monitor" />}
    </span>
  );
}

function ActiveMonitorBadge({
  autoMonitor,
  butlerEnabled,
  orchestratorAlive,
}: { autoMonitor: boolean; butlerEnabled: boolean; orchestratorAlive: boolean | undefined }) {
  const count = [orchestratorAlive, butlerEnabled, autoMonitor].filter(Boolean).length;
  if (count <= 1) return null;
  return (
    <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-accent-500 text-white text-[10px] font-semibold leading-none">
      {count}
    </span>
  );
}

export function formatBoardActivitySummary(activeColumns: StatusWithIssues[]) {
  const columnsByName = new Map(activeColumns.map((col) => [col.name, col]));
  const orderedNames = [
    ...BOARD_ACTIVITY_STATUS_ORDER,
    ...activeColumns.map((col) => col.name).filter((name) => !BOARD_ACTIVITY_STATUS_ORDER.includes(name)),
  ];

  return orderedNames
    .map((name) => columnsByName.get(name))
    .filter((col): col is StatusWithIssues => col !== undefined)
    .filter((col) => col.issues.length > 0)
    .map((col) => `${col.issues.length} ${col.name}`)
    .join(", ");
}
