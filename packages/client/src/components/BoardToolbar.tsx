import { useState } from "react";
import { BacklogPanel } from "./BacklogPanel.js";
import { MonitorPopover, type MonitorStatus } from "./MonitorPopover.js";
import { VoiceInboxButton } from "./VoiceInboxButton.js";
import { VIEW_REGISTRY } from "../lib/viewRegistry.js";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";

// Re-exported from the canonical view registry (#116). Kept here for back-compat
// with the many components that import `ViewMode` from BoardToolbar.
export type { ViewMode } from "../lib/viewRegistry.js";
import type { ViewMode } from "../lib/viewRegistry.js";

const ACTIVE_DEFAULT = "bg-brand-600 text-white hover:bg-brand-700";
const INACTIVE = "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700";

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
        className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
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
          className="relative shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h18M3 12h12M3 17h6" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l3 3-3 3" />
          </svg>
          Queue
          {mergeQueueCount > 0 && (
            <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-blue-500 text-white text-[10px] font-semibold leading-none">
              {mergeQueueCount > 99 ? "99+" : mergeQueueCount}
            </span>
          )}
        </button>
      )}
      <VoiceInboxButton projectId={projectId} onIssueCreated={onVoiceIssueCreated} />
      <div className="relative shrink-0 flex items-center gap-0.5">
        <button
          onClick={() => setShowMonitorPopover(v => !v)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${autoMonitor ? "bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800 text-green-700 hover:bg-green-100 dark:hover:bg-green-900" : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"}`}
          title={autoMonitor ? "Board monitor active — click for details" : "Board monitor — click to configure"}
        >
          {autoMonitor && <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
          Monitor
        </button>
        <button
          onClick={onMonitorRunNow}
          disabled={monitorRunning}
          className="flex items-center justify-center w-6 h-6 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
      <div className="flex items-center gap-1 border border-gray-200 dark:border-gray-700 rounded-md p-0.5 bg-white dark:bg-gray-900 shrink-0">
        {VIEW_REGISTRY.map((view) => {
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
      </div>
    </div>
  );
}
