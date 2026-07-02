import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { getBool } from "@agentic-kanban/shared/lib/settings-registry";
import { MonitorPopover, type MonitorStatus } from "./MonitorPopover.js";
import { useOrchestrator } from "../hooks/useOrchestrator.js";
import { getSettings } from "../lib/settingsStore.js";
import { VoiceInboxButton } from "./VoiceInboxButton.js";
import { ProjectScriptsMenu } from "./ProjectScriptsMenu.js";
import { PRIMARY_VIEWS, SECONDARY_VIEWS, VIEW_REGISTRY, type ViewDescriptor } from "../lib/viewRegistry.js";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import type { CardDensity } from "../hooks/useBoardPreferences.js";
import { PRIORITY_META } from "../lib/chartColors.js";
import { computeVisibleTabCount, splitToolbarViews } from "../lib/toolbarTabOverflow.js";
import { buildMonitorTitle, countActiveMonitors } from "../lib/monitorToolbarStatus.js";
import { validateAgingThreshold } from "../lib/agingHeatmapThresholds.js";
import { formatBoardActivitySummary } from "../lib/boardActivitySummary.js";

// Re-exported for back-compat with the sibling BoardToolbar.test.ts import.
export { formatBoardActivitySummary };

// Re-exported from the canonical view registry (#116). Kept here for back-compat
// with the many components that import `ViewMode` from BoardToolbar.
export type { ViewMode } from "../lib/viewRegistry.js";
import type { ViewMode } from "../lib/viewRegistry.js";

const ACTIVE_DEFAULT = "bg-brand-600 text-white hover:bg-brand-700";
const INACTIVE = "text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-700";

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
    const { valid, value } = validateAgingThreshold(raw, { which: "warm", warmDays, hotDays });
    if (valid) onChange(value, hotDays);
    else setWarmInput(String(warmDays));
  }

  function commitHot(raw: string) {
    const { valid, value } = validateAgingThreshold(raw, { which: "hot", warmDays, hotDays });
    if (valid) onChange(warmDays, value);
    else setHotInput(String(hotDays));
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
  showPriorityLegend?: boolean;
  onShowPriorityLegendChange?: (v: boolean) => void;
  showCardAgingHeatmap?: boolean;
  onShowCardAgingHeatmapChange?: (v: boolean) => void;
  agingWarmDays?: number;
  agingHotDays?: number;
  onAgingThresholdsChange?: (warm: number, hot: number) => void;
  swimlaneDimension?: "none" | "priority" | "tag";
  onSwimlaneChange?: (v: "none" | "priority" | "tag") => void;
}

export function BoardToolbar({
  activeColumns,
  onShowTimeReport: _onShowTimeReport,
  focusMode: _focusMode = false,
  onFocusModeChange: _onFocusModeChange,
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
  onShowMergeQueue: _onShowMergeQueue,
  mergeQueueCount: _mergeQueueCount = 0,
  onShowRunQueueForecast: _onShowRunQueueForecast,
  runQueueOpenSlots: _runQueueOpenSlots = 0,
  onShowLiveActivityTicker: _onShowLiveActivityTicker,
  liveActivityCount: _liveActivityCount = 0,
  onViewAllHealthEvents,
  cardDensity: _cardDensity = "comfortable",
  onCardDensityChange: _onCardDensityChange,
  visibilityColumns: _visibilityColumns,
  hiddenColumns: _hiddenColumns,
  onHiddenColumnsChange: _onHiddenColumnsChange,
  showPriorityLegend = false,
  onShowPriorityLegendChange: _onShowPriorityLegendChange,
  showCardAgingHeatmap = false,
  onShowCardAgingHeatmapChange: _onShowCardAgingHeatmapChange,
  agingWarmDays = 3,
  agingHotDays = 7,
  onAgingThresholdsChange,
  swimlaneDimension: _swimlaneDimension = "none",
  onSwimlaneChange: _onSwimlaneChange,
}: BoardToolbarProps) {
  const [showMonitorPopover, setShowMonitorPopover] = useState(false);
  const [showViewMenu, setShowViewMenu] = useState(false);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const [showActivityMenu, setShowActivityMenu] = useState(false);
  const activityMenuRef = useRef<HTMLDivElement>(null);
  // Occasional actions (quick tasks, scripts, export/import, voice capture) are
  // collapsed behind a "⋯" toggle on sm+ so they don't crowd the main bar. The
  // existing `showActions` toggle still gates the whole cluster on phones.
  const [showMoreActions, setShowMoreActions] = useState(false);
  const [showMoreViews, setShowMoreViews] = useState(false);
  const moreViewsRef = useRef<HTMLDivElement>(null);
  // sm+ : the primary view tabs overflow into the "More" dropdown responsively.
  // A hidden measurement row mirrors the real tabs; we compare their intrinsic
  // widths against the available row width and show as many tabs as fit, folding
  // the rest (plus the analytics/secondary views) into "More".
  const [visibleViewCount, setVisibleViewCount] = useState(PRIMARY_VIEWS.length);
  const viewTabsWrapRef = useRef<HTMLDivElement>(null);
  const viewTabsMeasureRef = useRef<HTMLDivElement>(null);
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
    getSettings()
      .then((s) => {
        setMonitorButlerEnabled(getBool(s, "monitor_butler_enabled"));
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
    if (!showViewMenu) return;
    function handleClick(e: MouseEvent) {
      if (viewMenuRef.current && !viewMenuRef.current.contains(e.target as Node)) {
        setShowViewMenu(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setShowViewMenu(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [showViewMenu]);

  useEffect(() => {
    if (!showActivityMenu) return;
    function handleClick(e: MouseEvent) {
      if (activityMenuRef.current && !activityMenuRef.current.contains(e.target as Node)) {
        setShowActivityMenu(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setShowActivityMenu(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [showActivityMenu]);

  // Measure intrinsic tab widths vs. available row width and recompute how many
  // primary tabs fit. Driven by a ResizeObserver on the wrapper plus the inputs
  // that change a tab's width (badge counts, the kanban activity summary).
  useLayoutEffect(() => {
    const wrap = viewTabsWrapRef.current;
    const measure = viewTabsMeasureRef.current;
    if (!wrap || !measure) return;

    function recompute() {
      // wrap/measure are guarded non-null above and are const refs; the guard's
      // narrowing isn't carried into this nested closure, so assert it.
      const avail = wrap!.clientWidth;
      if (avail <= 0) return;
      const children = Array.from(measure!.children) as HTMLElement[];
      if (children.length === 0) return;
      // Last measured child is the "More" trigger; the rest are primary tabs.
      const moreWidth = children[children.length - 1].offsetWidth;
      const tabWidths = children.slice(0, -1).map((el) => el.offsetWidth);
      setVisibleViewCount(computeVisibleTabCount({ availableWidth: avail, tabWidths, moreWidth }));
    }

    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [butlerBadgeCount, boardActivitySummary]);

  const { visiblePrimaryViews, moreViews, activeMoreView } =
    splitToolbarViews(PRIMARY_VIEWS, SECONDARY_VIEWS, visibleViewCount, viewMode);

  function renderViewTab(view: ViewDescriptor, measuring = false) {
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
        onClick={measuring ? undefined : () => onViewModeChange(view.id)}
        tabIndex={measuring ? -1 : undefined}
        className={`relative px-2.5 py-1 text-xs rounded flex items-center gap-1.5 whitespace-nowrap transition-colors ${isActive ? activeClass : INACTIVE}`}
        title={measuring ? undefined : title}
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
  }

  return (
    <>
    {/* flex-1 min-w-0 so this row fills the width its parent gives it (next to
        the board-summary chips). Without it the row stays content-sized and the
        responsive view-tab strip below gets almost no room, collapsing every
        tab into "More". */}
    <div className="flex flex-1 min-w-0 items-start gap-2 flex-wrap">
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
      <button
        onClick={() => setShowMoreActions((v) => !v)}
        aria-expanded={showMoreActions}
        title="More actions — quick tasks, scripts"
        className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${
          showMoreActions
            ? "bg-surface-sunken dark:bg-gray-800 border-black/[0.07] dark:border-white/10 text-ink dark:text-gray-200"
            : "bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
        }`}
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
        </svg>
        <span className="hidden sm:inline">More</span>
      </button>
      {showMoreActions && (
        <>
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
        </>
      )}
      {/* Voice capture stays on the bar at all times — quick idea/command entry
          shouldn't hide behind the More cluster. */}
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
            <>
              {/* Base monitor icon always renders so the button isn't empty on
                  small screens (the label is hidden < sm and the active dots are
                  null when no monitor mechanism is running). */}
              <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <rect x="3" y="4" width="18" height="12" rx="2" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 20h8M12 16v4" />
              </svg>
              <ActiveMonitorDots
                autoMonitor={autoMonitor}
                butlerEnabled={monitorButlerEnabled}
                orchestratorAlive={orchestrator?.available && orchestrator.alive}
              />
            </>
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
      {/* sm+ : responsive tab strip. Primary tabs fill the available row width;
          whatever doesn't fit folds into the "More" dropdown along with the
          analytics/secondary views. `visibleViewCount` is computed from the
          hidden measurement row below. */}
      {/* No overflow-hidden here: it would clip the "More" views dropdown
          (absolute, below the strip) and make it invisible — the popup opened
          in the DOM but nothing showed. The strip only ever renders the tabs
          that fit (visiblePrimaryViews) plus More, and useLayoutEffect flushes
          the measured count before paint, so there's no overflow to clip. */}
      <div ref={viewTabsWrapRef} className="relative hidden sm:block flex-1 min-w-0">
        <div className="flex w-fit items-center gap-1 border border-black/[0.07] dark:border-white/10 rounded-md p-0.5 bg-surface-raised dark:bg-surface-raised-dark">
          {visiblePrimaryViews.map((view) => renderViewTab(view))}
          {moreViews.length > 0 && (
            <div className="relative" ref={moreViewsRef}>
              <button
                onClick={() => setShowMoreViews((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={showMoreViews}
                className={`relative px-2.5 py-1 text-xs rounded flex items-center gap-1.5 whitespace-nowrap transition-colors ${activeMoreView ? (activeMoreView.activeClass ?? ACTIVE_DEFAULT) : INACTIVE}`}
                title={
                  activeMoreView
                    ? `${activeMoreView.tooltip} — more views`
                    : "More views"
                }
              >
                {activeMoreView ? (
                  <>
                    {activeMoreView.icon}
                    {activeMoreView.toolbarLabel}
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
                  className="absolute top-full right-0 mt-1 max-h-[70vh] w-48 overflow-y-auto bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-20 p-1"
                >
                  {moreViews.map((view) => {
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
        {/* Hidden measurement row — mirrors every primary tab plus a plain "More"
            trigger so the effect can measure intrinsic widths. Absolutely
            positioned + invisible so it never affects layout. */}
        <div
          ref={viewTabsMeasureRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute left-0 top-0 flex items-center gap-1 p-0.5"
        >
          {PRIMARY_VIEWS.map((view) => renderViewTab(view, true))}
          <button tabIndex={-1} className="px-2.5 py-1 text-xs rounded flex items-center gap-1.5 whitespace-nowrap">
            More
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>
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
    {/* Tag filtering moved into the unified BoardFilterMenu; the standalone TAGS
        legend row used to take a full header row of its own. */}
    </>
  );
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
  const count = countActiveMonitors(autoMonitor, butlerEnabled, orchestratorAlive);
  if (count <= 1) return null;
  return (
    <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-accent-500 text-white text-[10px] font-semibold leading-none">
      {count}
    </span>
  );
}

