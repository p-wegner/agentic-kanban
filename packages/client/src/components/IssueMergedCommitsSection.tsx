import { useEffect, useState } from "react";
import type { MergedCommit, MergedCommitsResponse } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";

interface IssueMergedCommitsSectionProps {
  issueId: string;
  /** Open the workspace panel (where the diff is viewable) for a merged commit. */
  onOpenDiff: (commit: MergedCommit) => void;
}

export function IssueMergedCommitsSection({ issueId, onOpenDiff }: IssueMergedCommitsSectionProps) {
  // Self-contained best-effort fetch — moved out of the panel's loadData
  // mega-effect. Owns its own loading + data state.
  const [data, setData] = useState<MergedCommitsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setData(null);
    setLoading(true);
    apiFetch<MergedCommitsResponse>(`/api/issues/${issueId}/merged-commits`)
      .then((mc) => setData(mc))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [issueId]);

  // Hide entirely until we know there's something to show or are still loading —
  // an un-merged issue shouldn't add a noisy empty panel to every detail view.
  if (!loading && (!data || !data.merged)) return null;

  return (
    <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
      <div className="flex items-center justify-between gap-2 mb-2">
        <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
          Merged commits
        </label>
        {!loading && data && data.commits.length > 0 && (
          <span className="text-[11px] text-gray-400 dark:text-gray-500">
            {data.commits.length}
            {data.defaultBranch ? ` on ${data.defaultBranch}` : ""}
          </span>
        )}
      </div>
      {loading ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">Loading merged commits...</p>
      ) : !data || data.commits.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">
          Merged, but no distinct commits were found for this issue.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {data.commits.map((commit) => (
            <li
              key={commit.sha}
              className="border border-gray-200 dark:border-gray-700 rounded px-2.5 py-2 bg-gray-50 dark:bg-gray-800/50"
            >
              <div className="flex items-center gap-2 text-[11px]">
                <code className="font-mono px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                  {commit.shortSha}
                </code>
                <span className="text-gray-500 dark:text-gray-400 truncate">{commit.author}</span>
                <span className="text-gray-400 dark:text-gray-500 ml-auto whitespace-nowrap">
                  {formatRelativeTime(commit.date)}
                </span>
              </div>
              <p className="mt-1 text-xs text-gray-700 dark:text-gray-300 break-words">
                {commit.message}
              </p>
              <div className="mt-1.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => onOpenDiff(commit)}
                  className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  View diff
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
