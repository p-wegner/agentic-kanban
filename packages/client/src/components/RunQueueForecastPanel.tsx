import type { IssueWithStatus, MainWorkspaceInfo, StatusWithIssues } from "@agentic-kanban/shared";
import { Icon } from "./Icon.js";
import { buildRunQueueForecast } from "../lib/runQueueForecast.js";

// #1102: the forecast math lives in lib/ now, so the Autopilot chip's hook can share it.
// Re-exported here so every existing importer of this module keeps working.
export { buildRunQueueForecast } from "../lib/runQueueForecast.js";
export type { RunQueueForecast, RunQueueForecastStart } from "../lib/runQueueForecast.js";

interface RunQueueForecastPanelProps {
  columns: StatusWithIssues[];
  activeTarget: string | number;
  onClose: () => void;
  onIssueClick: (issue: IssueWithStatus) => void;
  onDryRun?: (issue: IssueWithStatus) => void;
}


function CountTile({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`rounded border px-3 py-2 ${tone}`}>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] font-medium uppercase text-current/70">{label}</div>
    </div>
  );
}

export function RunQueueForecastPanel({ columns, activeTarget, onClose, onIssueClick, onDryRun }: RunQueueForecastPanelProps) {
  const forecast = buildRunQueueForecast(columns, activeTarget);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-[min(560px,100vw)] bg-surface-raised dark:bg-surface-raised-dark shadow-xl flex flex-col animate-slide-in-right">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 min-w-0">
            <Icon className="w-5 h-5 text-sky-600 shrink-0" d="M4 18V6m4 12V9m4 9v-5m4 5V4m4 14v-7" />
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-ink dark:text-stone-100 heading-serif">Run Queue Forecast</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">Read-only capacity from current board workspaces</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
            aria-label="Close run queue forecast"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <section>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <CountTile label="Active target" value={forecast.activeTarget} tone="border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300" />
              <CountTile label="Running" value={forecast.runningCount} tone="border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300" />
              <CountTile label="Idle" value={forecast.idleCount} tone="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300" />
              <CountTile label="Review" value={forecast.reviewCount} tone="border-accent-200 bg-accent-50 text-accent-700 dark:border-accent-900 dark:bg-accent-950/40 dark:text-accent-300" />
              <CountTile label="Pending merge" value={forecast.pendingMergeCount} tone="border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-300" />
              <CountTile label="Open slots" value={forecast.openSlots} tone="border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300" />
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Next likely starts</h3>
              <span className="text-xs text-gray-400 dark:text-gray-500">{forecast.nextStarts.length}/2</span>
            </div>
            {forecast.nextStarts.length === 0 ? (
              <div className="rounded border border-gray-200 dark:border-gray-700 px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                No startable Todo or Backlog issues are waiting for capacity.
              </div>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-gray-800 rounded border border-gray-200 dark:border-gray-700 overflow-hidden">
                {forecast.nextStarts.map((start, index) => (
                  <div key={start.issue.id} className="flex items-stretch">
                    <button
                      type="button"
                      onClick={() => {
                        onIssueClick(start.issue);
                        onClose();
                      }}
                      className="flex-1 px-3 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800 min-w-0"
                    >
                      <div className="flex items-start gap-2">
                        <span className="text-xs font-mono text-gray-400 dark:text-gray-500 mt-0.5 shrink-0">{index + 1}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-xs font-mono text-gray-400 dark:text-gray-500 shrink-0">#{start.issue.issueNumber}</span>
                            <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{start.issue.title}</span>
                          </div>
                          <div className="mt-1 flex items-center gap-2 flex-wrap">
                            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">{start.issue.statusName}</span>
                            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">{start.issue.priority}</span>
                            <span className="text-xs text-gray-500 dark:text-gray-400">{start.slotLabel}</span>
                          </div>
                        </div>
                      </div>
                    </button>
                    {onDryRun && (
                      <button
                        type="button"
                        title="Preview launch without creating a workspace"
                        aria-label={`Dry run preview for ${start.issue.title}`}
                        onClick={() => {
                          onDryRun(start.issue);
                          onClose();
                        }}
                        className="shrink-0 px-3 border-l border-gray-100 dark:border-gray-800 text-gray-400 dark:text-gray-500 hover:text-brand-600 dark:hover:text-brand-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors flex items-center"
                      >
                        <Icon className="h-4 w-4">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7Z" />
                        </Icon>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
