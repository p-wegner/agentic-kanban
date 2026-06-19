import type { PanelMode } from "../hooks/usePanelLayout.js";

interface WorkspacePanelHeaderProps {
  issueTitle: string;
  panelMode: PanelMode;
  monitorRunning: boolean;
  onTogglePanelMode: () => void;
  onHeaderMouseDown: (e: React.MouseEvent) => void;
  onMonitorRunNow: () => void;
  onClose: () => void;
}

/**
 * The WorkspacePanel title bar: draggable header with the issue title and the
 * detach/snap, run-monitor-now, and close controls. Extracted from
 * WorkspacePanel's render — presentational, all behavior via callbacks.
 */
export function WorkspacePanelHeader({
  issueTitle,
  panelMode,
  monitorRunning,
  onTogglePanelMode,
  onHeaderMouseDown,
  onMonitorRunNow,
  onClose,
}: WorkspacePanelHeaderProps) {
  return (
    <div
      className={`flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-700 min-w-0 cursor-grab active:cursor-grabbing ${panelMode === "modal" ? "rounded-t-lg" : ""}`}
      onMouseDown={onHeaderMouseDown}
    >
      <h2 className="flex-1 min-w-0 text-sm font-semibold text-ink dark:text-stone-100 truncate" title={issueTitle}>
        {issueTitle}
      </h2>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onTogglePanelMode}
          title={panelMode === "sidebar" ? "Detach to floating panel" : "Snap back to sidebar"}
          className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 p-0.5 rounded"
        >
          {panelMode === "modal" ? (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 9L4 4m0 0h5m-5 0v5M15 9l5-5m0 0h-5m5 0v5M9 15l-5 5m0 0h5m-5 0v-5M15 15l5 5m0 0h-5m5 0v-5" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5M20 8V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5M20 16v4m0 0h-4m4 0l-5-5" />
            </svg>
          )}
        </button>
        <button
          onClick={onMonitorRunNow}
          disabled={monitorRunning}
          className="flex items-center justify-center w-6 h-6 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Run monitor now and reset timer"
        >
          {monitorRunning
            ? <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
            : <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z"/></svg>
          }
        </button>
        <button
          onClick={onClose}
          className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
        >
          &times;
        </button>
      </div>
    </div>
  );
}
