import { useCallback, useEffect, useState } from "react";
import { apiFetch, apiPost } from "../lib/api.js";
import { LEADING_REPO_KEY } from "@agentic-kanban/shared";
import type { RepoMergeStatusResponse, RepoMergeStatusRepoEntry, RepoRebaseResponse } from "@agentic-kanban/shared";

type ActionPhase = "idle" | "running" | "done";

/** In-flight + result state of a single repo's rebase action, keyed by {@link repoKey}. */
interface RepoActionState {
  phase: ActionPhase;
  result?: RepoRebaseResponse;
}

/** In-flight + result state of the workspace-level retry-merge action. */
interface RetryState {
  phase: ActionPhase;
  error?: string;
}

/** The `:repoName` path segment addressing a repo in the per-repo rebase route (#93). */
function repoKey(repo: RepoMergeStatusRepoEntry): string {
  return repo.isLeading || repo.name === null ? LEADING_REPO_KEY : repo.name;
}

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

/** Compact result indicator for a completed/in-flight per-repo rebase. */
function rebaseResult(state: RepoActionState | undefined) {
  if (!state) return null;
  if (state.phase === "running") {
    return <span className="text-gray-500 dark:text-gray-400" data-testid="repo-rebase-result">rebasing…</span>;
  }
  const result = state.result;
  if (!result) return null;
  if (result.success) {
    return <span className="text-green-600 dark:text-green-400" data-testid="repo-rebase-result">rebased ✓</span>;
  }
  if (result.conflictingFiles && result.conflictingFiles.length > 0) {
    const shown = result.conflictingFiles.slice(0, 3).join(", ");
    const more = result.conflictingFiles.length > 3 ? ", …" : "";
    return (
      <span className="text-red-600 dark:text-red-400" data-testid="repo-rebase-result" title={result.conflictingFiles.join(", ")}>
        conflicts: {shown}{more}
      </span>
    );
  }
  return <span className="text-red-600 dark:text-red-400" data-testid="repo-rebase-result">rebase failed</span>;
}

/**
 * Per-repo merge-status strip for a multi-repo workspace (#79): one compact row
 * per repo (leading + siblings) showing whether its work has landed on base, so a
 * partial multi-repo merge (the #69 stranded-sibling failure mode) is visible in
 * the workspace detail instead of hiding behind the single scalar `mergedAt`.
 * Renders nothing for single-repo workspaces.
 *
 * When action callbacks are supplied (#93) the strip becomes actionable: a stranded
 * repo gets a "Rebase onto base" button (per-repo update-base — REBASE only, never a
 * single-repo merge), and the workspace gets a "Retry merge" button that re-runs the
 * coordinated all-or-nothing sibling merge. Without callbacks it renders read-only.
 */
export function RepoMergeStatusStripView({
  status,
  onRebaseRepo,
  onRetryMerge,
  actionState,
  retryState,
}: {
  status: RepoMergeStatusResponse | null;
  onRebaseRepo?: (repoKey: string) => void;
  onRetryMerge?: () => void;
  actionState?: Record<string, RepoActionState>;
  retryState?: RetryState;
}) {
  if (!status || status.repos.length <= 1) return null;
  const stranded = status.repos.filter((r) => r.stranded).length;
  const retryPhase = retryState?.phase ?? "idle";
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
        {onRetryMerge && !status.allMerged && (
          <button
            type="button"
            className="ml-auto px-2 py-0.5 rounded bg-violet-600 hover:bg-violet-700 text-white font-medium disabled:opacity-50"
            data-testid="retry-merge-button"
            disabled={retryPhase === "running"}
            onClick={onRetryMerge}
            title="Re-run the coordinated all-or-nothing sibling merge"
          >
            {retryPhase === "running" ? "merging…" : "Retry merge"}
          </button>
        )}
      </div>
      {retryState?.error && (
        <div className="mt-1 text-red-600 dark:text-red-400" data-testid="retry-merge-error">{retryState.error}</div>
      )}
      <div className="mt-1 flex flex-col gap-0.5">
        {status.repos.map((repo) => {
          const key = repoKey(repo);
          const state = actionState?.[key];
          const canRebase = Boolean(onRebaseRepo) && repo.stranded;
          return (
            <div key={repo.path} className="flex items-center gap-2" data-testid="repo-merge-status-row">
              <span className="font-mono truncate text-gray-600 dark:text-gray-300" title={repo.path}>
                {repo.name ?? "leading"}
              </span>
              {repoStateBadge(repo)}
              {canRebase && (
                <button
                  type="button"
                  className="px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
                  data-testid="repo-rebase-button"
                  disabled={state?.phase === "running"}
                  onClick={() => onRebaseRepo?.(key)}
                  title="Rebase this repo's branch onto its base"
                >
                  Rebase onto base
                </button>
              )}
              {rebaseResult(state)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Self-fetching wrapper: loads GET /api/workspaces/:id/repo-merge-status once per
 * workspace (re-fetched when `refreshKey` changes, e.g. after a merge). Errors —
 * direct workspace (400), older server (404) — just leave the strip unrendered.
 *
 * Owns the action state for the per-repo rebase + workspace retry-merge (#93): it POSTs
 * to the sanctioned endpoints, tracks in-flight/result state, and re-fetches the status
 * after a successful action so the rows reflect the new merge state.
 */
export function RepoMergeStatusStrip({ workspaceId, refreshKey }: { workspaceId: string; refreshKey?: string | null }) {
  const [status, setStatus] = useState<RepoMergeStatusResponse | null>(null);
  const [nonce, setNonce] = useState(0);
  const [actionState, setActionState] = useState<Record<string, RepoActionState>>({});
  const [retryState, setRetryState] = useState<RetryState>({ phase: "idle" });

  useEffect(() => {
    let cancelled = false;
    apiFetch<RepoMergeStatusResponse>(`/api/workspaces/${workspaceId}/repo-merge-status`)
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [workspaceId, refreshKey, nonce]);

  const onRebaseRepo = useCallback(async (key: string) => {
    setActionState((prev) => ({ ...prev, [key]: { phase: "running" } }));
    try {
      const result = await apiPost<RepoRebaseResponse>(
        `/api/workspaces/${workspaceId}/repos/${encodeURIComponent(key)}/rebase`,
      );
      setActionState((prev) => ({ ...prev, [key]: { phase: "done", result } }));
      if (result.success) setNonce((n) => n + 1); // refresh status after a clean rebase
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setActionState((prev) => ({ ...prev, [key]: { phase: "done", result: { repo: key, success: false, error: message } } }));
    }
  }, [workspaceId]);

  const onRetryMerge = useCallback(async () => {
    setRetryState({ phase: "running" });
    try {
      await apiPost(`/api/workspaces/${workspaceId}/merge`);
      setRetryState({ phase: "done" });
      setNonce((n) => n + 1); // refresh status after the coordinated merge
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRetryState({ phase: "done", error: message });
    }
  }, [workspaceId]);

  return (
    <RepoMergeStatusStripView
      status={status}
      onRebaseRepo={onRebaseRepo}
      onRetryMerge={onRetryMerge}
      actionState={actionState}
      retryState={retryState}
    />
  );
}
