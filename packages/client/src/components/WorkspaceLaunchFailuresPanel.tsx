import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import type { WorkspaceLaunchFailure, WorkspaceLaunchFailuresResponse } from "@agentic-kanban/shared";

interface WorkspaceLaunchFailuresPanelProps {
  projectId: string | null;
  onClose: () => void;
  onIssueClick?: (issueId: string) => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  "zero-output": "Launch failed",
  "setup-failed": "Setup failed",
  "missing-worktree": "Missing worktree",
  "session-error": "Session error",
};

const CATEGORY_COLORS: Record<string, string> = {
  "zero-output": "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  "setup-failed": "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  "missing-worktree": "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  "session-error": "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

function FailureRow({
  failure,
  onResume,
  onStop,
  onQuarantine,
  onOpenIssue,
  actionLoading,
}: {
  failure: WorkspaceLaunchFailure;
  onResume: (f: WorkspaceLaunchFailure) => void;
  onStop: (f: WorkspaceLaunchFailure) => void;
  onQuarantine: (f: WorkspaceLaunchFailure) => void;
  onOpenIssue?: (issueId: string) => void;
  actionLoading: string | null;
}) {
  const isRunning = failure.sessionStatus === "running";
  const canStop = isRunning && failure.sessionId;
  const canResume = !isRunning;
  const isActing = actionLoading === failure.workspaceId;

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 space-y-2 bg-surface dark:bg-surface-dark">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {failure.issueNumber != null && (
            <button
              className="text-xs font-mono text-brand-600 dark:text-brand-400 hover:underline flex-shrink-0"
              onClick={() => onOpenIssue?.(failure.issueId)}
              title="Open issue"
            >
              #{failure.issueNumber}
            </button>
          )}
          <span className="text-sm font-medium text-ink dark:text-stone-100 truncate" title={failure.issueTitle}>
            {failure.issueTitle}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {failure.recentFailureCount > 1 && (
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" title={`${failure.recentFailureCount} recent failures`}>
              ×{failure.recentFailureCount}
            </span>
          )}
          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${CATEGORY_COLORS[failure.failureCategory] ?? "bg-gray-100 text-gray-600"}`}>
            {CATEGORY_LABELS[failure.failureCategory] ?? failure.failureCategory}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
        <span className="font-mono truncate max-w-[160px]" title={failure.workspaceBranch}>
          {failure.workspaceBranch}
        </span>
        {failure.provider && (
          <span className="capitalize">{failure.provider}{failure.profile ? ` / ${failure.profile}` : ""}</span>
        )}
        <span className="ml-auto flex-shrink-0">{formatRelativeTime(failure.failedAt)}</span>
      </div>

      {failure.lastMessage && (
        <pre className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap break-all line-clamp-3">
          {failure.lastMessage}
        </pre>
      )}

      <div className="flex items-center gap-2 pt-0.5">
        {canResume && (
          <button
            disabled={isActing}
            onClick={() => onResume(failure)}
            className="text-xs px-2.5 py-1 rounded bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isActing ? "Resuming…" : "Resume"}
          </button>
        )}
        {canStop && (
          <button
            disabled={isActing}
            onClick={() => onStop(failure)}
            className="text-xs px-2.5 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isActing ? "Stopping…" : "Stop"}
          </button>
        )}
        <button
          disabled={isActing}
          onClick={() => onQuarantine(failure)}
          className="text-xs px-2.5 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="Stop session and move issue back to In Progress"
        >
          {isActing ? "Working…" : "Reset to In Progress"}
        </button>
        {onOpenIssue && (
          <button
            onClick={() => onOpenIssue(failure.issueId)}
            className="text-xs px-2.5 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            Open issue
          </button>
        )}
      </div>
    </div>
  );
}

export function WorkspaceLaunchFailuresPanel({ projectId, onClose, onIssueClick }: WorkspaceLaunchFailuresPanelProps) {
  const [data, setData] = useState<WorkspaceLaunchFailuresResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  const fetchFailures = useCallback(() => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    apiFetch<WorkspaceLaunchFailuresResponse>(`/api/projects/${projectId}/workspace-launch-failures`)
      .then((d) => setData(d))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    fetchFailures();
  }, [fetchFailures]);

  async function handleResume(failure: WorkspaceLaunchFailure) {
    setActionLoading(failure.workspaceId);
    setActionErrors((prev) => { const next = { ...prev }; delete next[failure.workspaceId]; return next; });
    try {
      await apiFetch(`/api/workspaces/${failure.workspaceId}/launch`, { method: "POST" });
      fetchFailures();
    } catch (err) {
      setActionErrors((prev) => ({ ...prev, [failure.workspaceId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setActionLoading(null);
    }
  }

  async function handleStop(failure: WorkspaceLaunchFailure) {
    if (!failure.sessionId) return;
    setActionLoading(failure.workspaceId);
    setActionErrors((prev) => { const next = { ...prev }; delete next[failure.workspaceId]; return next; });
    try {
      await apiFetch(`/api/sessions/${failure.sessionId}/stop`, { method: "POST" });
      fetchFailures();
    } catch (err) {
      setActionErrors((prev) => ({ ...prev, [failure.workspaceId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setActionLoading(null);
    }
  }

  async function handleQuarantine(failure: WorkspaceLaunchFailure) {
    setActionLoading(failure.workspaceId);
    setActionErrors((prev) => { const next = { ...prev }; delete next[failure.workspaceId]; return next; });
    try {
      await apiFetch(`/api/workspaces/${failure.workspaceId}/quarantine`, { method: "POST" });
      fetchFailures();
    } catch (err) {
      setActionErrors((prev) => ({ ...prev, [failure.workspaceId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setActionLoading(null);
    }
  }

  const failures = data?.failures ?? [];
  const byCategory = {
    "zero-output": failures.filter(f => f.failureCategory === "zero-output"),
    "setup-failed": failures.filter(f => f.failureCategory === "setup-failed"),
    "missing-worktree": failures.filter(f => f.failureCategory === "missing-worktree"),
    "session-error": failures.filter(f => f.failureCategory === "session-error"),
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-[min(520px,100vw)] bg-surface-raised dark:bg-surface-raised-dark shadow-xl flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <svg className="h-5 w-5 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <h2 className="text-lg font-semibold text-ink dark:text-stone-100 heading-serif">Launch Failures</h2>
            {!loading && (
              <span className="text-sm text-gray-500 dark:text-gray-400">
                ({failures.length})
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchFailures}
              disabled={loading}
              className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
              title="Refresh"
            >
              <svg className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
              title="Close"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {error && (
            <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded p-3">
              {error}
            </div>
          )}
          {loading && failures.length === 0 && (
            <div className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">Loading…</div>
          )}
          {!loading && failures.length === 0 && !error && (
            <div className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">
              No launch failures detected.
            </div>
          )}

          {(["zero-output", "setup-failed", "missing-worktree", "session-error"] as const).map((cat) => {
            const items = byCategory[cat];
            if (items.length === 0) return null;
            return (
              <div key={cat} className="space-y-2">
                <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide flex items-center gap-1.5">
                  <span className={`inline-block w-2 h-2 rounded-full ${cat === "zero-output" ? "bg-orange-400" : cat === "missing-worktree" ? "bg-yellow-400" : "bg-red-400"}`} />
                  {CATEGORY_LABELS[cat]} ({items.length})
                </h3>
                {items.map((f) => (
                  <div key={f.workspaceId}>
                    <FailureRow
                      failure={f}
                      onResume={handleResume}
                      onStop={handleStop}
                      onQuarantine={handleQuarantine}
                      onOpenIssue={onIssueClick}
                      actionLoading={actionLoading}
                    />
                    {actionErrors[f.workspaceId] && (
                      <p className="text-xs text-red-500 dark:text-red-400 mt-1 px-1">{actionErrors[f.workspaceId]}</p>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
