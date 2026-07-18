import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import type { RepoMergeStatusResponse, RepoMergeStatusRepoEntry } from "@agentic-kanban/shared";

function repoStateBadge(repo: RepoMergeStatusRepoEntry) {
  if (!repo.hasWork) {
    return (
      <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
        no changes
      </span>
    );
  }
  if (repo.stranded) {
    return (
      <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300 font-medium">
        {repo.ahead} ahead
      </span>
    );
  }
  return (
    <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300 font-medium">
      merged
    </span>
  );
}

/**
 * Per-repo merge-status strip for a multi-repo workspace (#79): one compact row
 * per repo (leading + siblings) showing whether its work has landed on base, so a
 * partial multi-repo merge (the #69 stranded-sibling failure mode) is visible in
 * the workspace detail instead of hiding behind the single scalar `mergedAt`.
 * Renders nothing for single-repo workspaces.
 */
export function RepoMergeStatusStripView({ status }: { status: RepoMergeStatusResponse | null }) {
  if (!status || status.repos.length <= 1) return null;
  const stranded = status.repos.filter((r) => r.stranded).length;
  return (
    <div
      className="rounded border border-gray-200 dark:border-gray-700 p-2 text-xs"
      data-testid="repo-merge-status-strip"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold text-gray-700 dark:text-gray-300">Repos</span>
        {status.allMerged ? (
          <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300 font-medium" data-testid="repo-merge-summary">
            all merged
          </span>
        ) : (
          <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 font-medium" data-testid="repo-merge-summary">
            {stranded > 0 ? `${stranded} unmerged` : "not all merged"}
          </span>
        )}
        <span className="text-gray-400 dark:text-gray-500">→ {status.baseBranch}</span>
      </div>
      <div className="mt-1 flex flex-col gap-0.5">
        {status.repos.map((repo) => (
          <div key={repo.path} className="flex items-center gap-2" data-testid="repo-merge-status-row">
            <span className="font-mono truncate text-gray-600 dark:text-gray-300" title={repo.path}>
              {repo.name ?? "leading"}
            </span>
            {repoStateBadge(repo)}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Self-fetching wrapper: loads GET /api/workspaces/:id/repo-merge-status once per
 * workspace (re-fetched when `refreshKey` changes, e.g. after a merge). Errors —
 * direct workspace (400), older server (404) — just leave the strip unrendered.
 */
export function RepoMergeStatusStrip({ workspaceId, refreshKey }: { workspaceId: string; refreshKey?: string | null }) {
  const [status, setStatus] = useState<RepoMergeStatusResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch<RepoMergeStatusResponse>(`/api/workspaces/${workspaceId}/repo-merge-status`)
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [workspaceId, refreshKey]);
  return <RepoMergeStatusStripView status={status} />;
}
