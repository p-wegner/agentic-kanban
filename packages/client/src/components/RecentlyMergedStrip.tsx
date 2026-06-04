import type { IssueWithStatus } from "@agentic-kanban/shared";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";

const MAX_RECENT = 8;

interface RecentlyMergedStripProps {
  columns: { issues: IssueWithStatus[] }[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenDiff: (issue: IssueWithStatus, workspaceId: string) => void;
}

export function RecentlyMergedStrip({ columns, collapsed, onToggleCollapsed, onOpenDiff }: RecentlyMergedStripProps) {
  const recentMerges = columns
    .flatMap((c) => c.issues)
    .filter((i) => i.workspaceSummary?.main?.mergedAt)
    .sort((a, b) => {
      const aTime = new Date(a.workspaceSummary!.main!.mergedAt!).getTime();
      const bTime = new Date(b.workspaceSummary!.main!.mergedAt!).getTime();
      return bTime - aTime;
    })
    .slice(0, MAX_RECENT);

  if (recentMerges.length === 0) return null;

  return (
    <div className="border-b border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/20 px-3 py-1.5 shrink-0">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:text-emerald-800 dark:hover:text-emerald-200 transition-colors"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand recently merged" : "Collapse recently merged"}
        >
          <svg
            className={`w-3 h-3 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
            fill="currentColor"
            viewBox="0 0 16 16"
          >
            <path d="M6 12l4-4-4-4v8z" />
          </svg>
          <svg className="w-3.5 h-3.5 shrink-0 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          Recently merged
          <span className="ml-0.5 text-emerald-500 dark:text-emerald-400 font-normal">({recentMerges.length})</span>
        </button>
      </div>
      {!collapsed && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {recentMerges.map((issue) => {
            const ws = issue.workspaceSummary?.main;
            if (!ws) return null;
            return (
              <button
                key={issue.id}
                type="button"
                onClick={() => onOpenDiff(issue, ws.id)}
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 dark:border-emerald-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-800 dark:text-gray-200 hover:border-emerald-400 dark:hover:border-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 transition-colors max-w-[20rem]"
                title={`#${issue.issueNumber ?? ""} ${issue.title} — merged ${formatRelativeTime(ws.mergedAt!)}`}
              >
                {issue.issueNumber != null && (
                  <span className="font-mono text-gray-400 dark:text-gray-500 shrink-0">#{issue.issueNumber}</span>
                )}
                <span className="truncate">{issue.title}</span>
                <span className="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400 font-medium whitespace-nowrap">
                  {formatRelativeTime(ws.mergedAt!)}
                </span>
                <svg className="w-3 h-3 shrink-0 text-emerald-400 dark:text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
