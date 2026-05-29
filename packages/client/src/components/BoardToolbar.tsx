import { useState } from "react";
import { BacklogPanel } from "./BacklogPanel.js";
import { MonitorPopover, type MonitorStatus } from "./MonitorPopover.js";
import { VoiceInboxButton } from "./VoiceInboxButton.js";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";

export type ViewMode = "kanban" | "graph" | "table" | "agents" | "timeline" | "metrics" | "butler" | "workflows" | "insights" | "swimlane" | "flaky-tests" | "digest" | "focus";

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
        <button
          onClick={() => onViewModeChange("kanban")}
          className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "kanban" ? "bg-brand-600 text-white hover:bg-brand-700" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
          title="Kanban view (b)"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="3" width="5" height="18" rx="1" />
            <rect x="10" y="3" width="5" height="14" rx="1" />
            <rect x="17" y="3" width="5" height="10" rx="1" />
          </svg>
          Board
        </button>
        <button
          onClick={() => onViewModeChange("graph")}
          className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "graph" ? "bg-brand-600 text-white hover:bg-brand-700" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
          title="Graph view (g)"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <circle cx="5" cy="12" r="2" />
            <circle cx="19" cy="5" r="2" />
            <circle cx="19" cy="19" r="2" />
            <path d="M7 12h6M15 6.5l-4 4M15 17.5l-4-4" />
          </svg>
          Graph
        </button>
        <button
          onClick={() => onViewModeChange("table")}
          className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "table" ? "bg-brand-600 text-white hover:bg-brand-700" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
          title="Table view (t)"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path d="M3 6h18M3 12h18M3 18h18M8 6v12" />
          </svg>
          Table
        </button>
        <button
          onClick={() => onViewModeChange("agents")}
          className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "agents" ? "bg-brand-600 text-white hover:bg-brand-700" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
          title="Agents view (l)"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="8" r="4" />
            <path d="M6 20v-2a6 6 0 0 1 12 0v2" />
            <circle cx="12" cy="8" r="1.5" fill="currentColor" stroke="none" />
          </svg>
          Agents
        </button>
        <button
          onClick={() => onViewModeChange("timeline")}
          className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "timeline" ? "bg-brand-600 text-white hover:bg-brand-700" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
          title="Timeline view (f)"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18M3 10h12M3 14h8M3 18h5" />
            <circle cx="20" cy="6" r="1.5" fill="currentColor" stroke="none" />
          </svg>
          Timeline
        </button>
        <button
          onClick={() => onViewModeChange("metrics")}
          className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "metrics" ? "bg-brand-600 text-white hover:bg-brand-700" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
          title="Metrics view (m)"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          Metrics
        </button>
        <button
          onClick={() => onViewModeChange("digest")}
          className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "digest" ? "bg-brand-600 text-white hover:bg-brand-700" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
          title="Standup Digest — what changed since you were away (d)"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Digest
        </button>
        <button
          onClick={() => onViewModeChange("focus")}
          className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "focus" ? "bg-brand-600 text-white hover:bg-brand-700" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
          title="Focus — what should I work on next? (o)"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
          Focus
        </button>
        <button
          onClick={() => onViewModeChange("butler")}
          className={`relative px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "butler" ? "bg-brand-600 text-white hover:bg-brand-700" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
          title={butlerBadgeCount > 0 ? `Butler chat (i) — ${butlerBadgeCount} pending agent question${butlerBadgeCount === 1 ? "" : "s"}` : "Butler chat (i)"}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
          </svg>
          Butler
          {butlerBadgeCount > 0 && (
            <span
              className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-amber-500 text-white text-[10px] font-semibold leading-none"
              aria-label={`${butlerBadgeCount} pending agent questions`}
            >
              {butlerBadgeCount > 99 ? "99+" : butlerBadgeCount}
            </span>
          )}
        </button>
        <button
          onClick={() => onViewModeChange("workflows")}
          className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "workflows" ? "bg-brand-600 text-white hover:bg-brand-700" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
          title="Workflows — design ticket-type pipelines"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h4.5v4.5h-4.5v-4.5zM15.75 12.75h4.5v4.5h-4.5v-4.5zM8.25 9h4.5m-2.25 0v6.75m0 0h3" />
          </svg>
          Workflows
        </button>
        <button
          onClick={() => onViewModeChange("insights")}
          className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "insights" ? "bg-blue-600 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
          title="Insights — agent cost, tokens, success rate (n)"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 13l4-4 4 4 4-8 4 4" />
          </svg>
          Insights
        </button>
        <button
          onClick={() => onViewModeChange("swimlane")}
          className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "swimlane" ? "bg-blue-600 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
          title="Swimlane — priority lanes × status columns (p)"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18M3 12h18M3 18h18" />
          </svg>
          Swimlane
        </button>
        <button
          onClick={() => onViewModeChange("flaky-tests")}
          className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "flaky-tests" ? "bg-amber-500 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
          title="Flaky Tests Radar — intermittent failures (k)"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          Flaky
        </button>
      </div>
    </div>
  );
}
