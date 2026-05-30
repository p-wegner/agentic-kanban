import { useState, useRef, useEffect } from "react";
import { BacklogPanel } from "./BacklogPanel.js";
import { MonitorPopover, type MonitorStatus } from "./MonitorPopover.js";
import { VoiceInboxButton } from "./VoiceInboxButton.js";
import { PRIMARY_VIEWS, SECONDARY_VIEWS } from "../lib/viewRegistry.js";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";

// Re-exported from the canonical view registry (#116). Kept here for back-compat
// with the many components that import `ViewMode` from BoardToolbar.
export type { ViewMode } from "../lib/viewRegistry.js";
import type { ViewMode } from "../lib/viewRegistry.js";

const ACTIVE_DEFAULT = "bg-brand-600 text-white hover:bg-brand-700";
const INACTIVE = "text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-700";
const BOARD_ACTIVITY_STATUS_ORDER = ["In Progress", "In Review", "AI Reviewed", "Todo"];

interface BoardToolbarProps {
  backlogColumn: StatusWithIssues | undefined;
  activeColumns: StatusWithIssues[];
  searchQuery: string;
  onIssueClick: (issue: IssueWithStatus) => void;
  onBacklogMoved: () => void;
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
}

export function BoardToolbar({
  backlogColumn,
  activeColumns,
  searchQuery,
  onIssueClick,
  onBacklogMoved,
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
}: BoardToolbarProps) {
  const [showMonitorPopover, setShowMonitorPopover] = useState(false);
  const [showMoreViews, setShowMoreViews] = useState(false);
  const moreViewsRef = useRef<HTMLDivElement>(null);
  const boardActivitySummary = formatBoardActivitySummary(activeColumns);

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

  const activeSecondaryView = SECONDARY_VIEWS.find((v) => v.id === viewMode);

  return (
    <div className="flex items-start gap-2 flex-wrap">
      {backlogColumn !== undefined && (
        <BacklogPanel
          backlogColumn={backlogColumn}
          activeColumns={activeColumns}
          searchQuery={searchQuery}
          onIssueClick={onIssueClick}
          onMoved={onBacklogMoved}
        />
      )}
      <button
        onClick={onShowQuickTasks}
        title="Quick Tasks - run a skill directly on the current checkout (q)"
        className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
      >
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <polygon points="5,3 19,12 5,21" />
        </svg>
        Tasks
      </button>
      {onShowMergeQueue && (
        <button
          onClick={onShowMergeQueue}
          title="Smart Merge Queue — auto-order and merge ready workspaces"
          className="relative shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h18M3 12h12M3 17h6" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l3 3-3 3" />
          </svg>
          Queue
          {mergeQueueCount > 0 && (
            <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-brand-500 text-white text-[10px] font-semibold leading-none">
              {mergeQueueCount > 99 ? "99+" : mergeQueueCount}
            </span>
          )}
        </button>
      )}
      <VoiceInboxButton projectId={projectId} onIssueCreated={onVoiceIssueCreated} />
      <div className="relative shrink-0 flex items-center gap-0.5">
        <button
          onClick={() => setShowMonitorPopover(v => !v)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${autoMonitor ? "bg-accent-50 dark:bg-accent-950 border-accent-200 dark:border-accent-800 text-accent-700 hover:bg-accent-100 dark:hover:bg-accent-900" : "bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"}`}
          title={autoMonitor ? "Board monitor active — click for details" : "Board monitor — click to configure"}
        >
          {autoMonitor && <span className="w-2 h-2 rounded-full bg-accent-500 animate-pulse" />}
          Monitor
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
          />
        )}
      </div>
      <div className="flex items-center gap-1 border border-black/[0.07] dark:border-white/10 rounded-md p-0.5 bg-surface-raised dark:bg-surface-raised-dark shrink-0">
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
    .filter((col): col is StatusWithIssues => Boolean(col) && col.issues.length > 0)
    .map((col) => `${col.issues.length} ${col.name}`)
    .join(", ");
}
