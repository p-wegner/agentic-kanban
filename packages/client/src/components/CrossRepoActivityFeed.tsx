import { useCallback } from "react";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { LEADING_REPO_LABEL } from "../lib/groupConflictsByRepo.js";
import { useCrossRepoActivity } from "../hooks/useCrossRepoActivity.js";
import type { CrossRepoActivityKind } from "../lib/crossRepoActivity.js";

interface CrossRepoActivityFeedProps {
  projectId: string;
  /** Resolve an issue's number for entry links/labels (built from the board columns). */
  resolveIssue?: (issueId: string) => { issueNumber: number | null } | undefined;
  onIssueClick?: (issueId: string) => void;
}

const KIND_META: Record<CrossRepoActivityKind, { label: string; dot: string }> = {
  repo_merged: { label: "merged", dot: "bg-emerald-500" },
  repo_ahead: { label: "commits", dot: "bg-blue-500" },
  repo_stranded: { label: "stranded", dot: "bg-amber-500" },
  conflict_appeared: { label: "conflict", dot: "bg-red-500" },
  conflict_cleared: { label: "conflict cleared", dot: "bg-emerald-500" },
  handoff_updated: { label: "handoff", dot: "bg-violet-500" },
};

/** Repo chip: distinguishes the leading repo from a sibling by name (#88). */
function RepoChip({ repo }: { repo: string }) {
  const isLeading = repo === LEADING_REPO_LABEL;
  return (
    <span
      className={
        "shrink-0 px-1.5 py-0.5 rounded text-[10px] font-mono font-medium " +
        (isLeading
          ? "bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300"
          : "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300")
      }
      title={isLeading ? "Leading repo" : `Sibling repo: ${repo}`}
    >
      {repo}
    </span>
  );
}

/**
 * Cross-Repo Activity Feed (#88): a live, chronological, repo-labeled timeline of
 * what is landing across a multi-repo project — merges, new commits, stranded work,
 * and conflicts appearing/clearing. Driven by {@link useCrossRepoActivity}, which
 * diffs per-repo merge-status/conflict snapshots on board-events WS reasons. Read-only.
 */
export function CrossRepoActivityFeed({ projectId, resolveIssue, onIssueClick }: CrossRepoActivityFeedProps) {
  const { entries, loading, multiRepo, refresh } = useCrossRepoActivity(projectId, resolveIssue);

  const handleRefresh = useCallback(() => refresh(), [refresh]);

  return (
    <div className="flex flex-col h-full overflow-hidden p-4" data-testid="cross-repo-activity-feed">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Cross-Repo Activity</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {entries.length} event{entries.length !== 1 ? "s" : ""}
          </span>
          <button
            onClick={handleRefresh}
            disabled={loading}
            title="Refresh"
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-40 text-sm px-1 rounded"
          >
            ↻
          </button>
        </div>
      </div>

      {entries.length === 0 && (
        <div className="flex flex-col items-center justify-center flex-1 gap-2 text-center">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          <p className="text-sm text-gray-400 dark:text-gray-500">
            {multiRepo ? "No cross-repo activity yet." : "No multi-repo workspaces."}
          </p>
          <p className="text-xs text-gray-300 dark:text-gray-600">
            {multiRepo
              ? "Merges, commits, conflicts, and handoffs across repos will appear here live."
              : "This view lights up when a project has additional repos with active workspaces."}
          </p>
        </div>
      )}

      {entries.length > 0 && (
        <div className="flex-1 overflow-y-auto">
          <ul className="space-y-0">
            {entries.map((entry) => {
              const meta = KIND_META[entry.kind];
              return (
                <li key={`${entry.id}:${entry.timestamp}`} className="flex items-start gap-2 py-2 px-2 rounded hover:bg-gray-50 dark:hover:bg-gray-800/50 group">
                  <span className={`shrink-0 mt-1.5 h-2 w-2 rounded-full ${meta.dot}`} />
                  <RepoChip repo={entry.repo} />
                  <span className="flex-1 min-w-0">
                    <span className="text-xs text-gray-700 dark:text-gray-300 leading-snug break-words">
                      {entry.summary}
                    </span>
                    {entry.issueId && (
                      <button
                        type="button"
                        onClick={() => onIssueClick?.(entry.issueId!)}
                        className="block mt-0.5 text-[11px] text-gray-400 dark:text-gray-500 hover:text-brand-600 dark:hover:text-brand-400 hover:underline text-left truncate max-w-full"
                      >
                        {entry.issueNumber != null ? `#${entry.issueNumber} · ` : ""}open issue
                      </button>
                    )}
                  </span>
                  <span className="shrink-0 text-[11px] text-gray-400 dark:text-gray-500 tabular-nums pt-0.5" title={meta.label}>
                    {formatRelativeTime(entry.timestamp)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
