import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";

interface CleanupWarningEntry {
  id: string;
  branch: string;
  workingDir: string | null;
  cleanupWarning: string;
  closedAt: string | null;
  mergedAt: string | null;
  updatedAt: string | null;
  issueId: string;
  issueNumber: number;
  issueTitle: string;
  projectId: string;
}

interface CleanupQueuePanelProps {
  projectId: string | null;
  onClose: () => void;
}

export function CleanupQueuePanel({ projectId, onClose }: CleanupQueuePanelProps) {
  const [entries, setEntries] = useState<CleanupWarningEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});
  const [retrySucceeded, setRetrySucceeded] = useState<Set<string>>(new Set());

  const fetchWarnings = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const qs = projectId ? `?projectId=${projectId}` : "";
      const data = await apiFetch<CleanupWarningEntry[]>(`/api/workspaces/cleanup-warnings${qs}`);
      setEntries(data);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : "Failed to load cleanup warnings");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchWarnings();
  }, [fetchWarnings]);

  async function handleRetry(id: string) {
    setRetryingId(id);
    setRetryErrors((prev) => { const n = { ...prev }; delete n[id]; return n; });
    try {
      await apiFetch(`/api/workspaces/${id}/retry-cleanup`, { method: "POST" });
      setRetrySucceeded((prev) => new Set([...prev, id]));
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Retry failed";
      setRetryErrors((prev) => ({ ...prev, [id]: msg }));
    } finally {
      setRetryingId(null);
    }
  }

  async function handleRetryAll() {
    const pending = entries.filter((e) => !retrySucceeded.has(e.id));
    for (const entry of pending) {
      await handleRetry(entry.id);
    }
  }

  const ageOf = (entry: CleanupWarningEntry) =>
    entry.updatedAt ?? entry.closedAt ?? entry.mergedAt ?? null;

  const pendingCount = entries.length;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1" onClick={onClose} />
      <div className="w-[600px] h-full bg-zinc-900 border-l border-zinc-700 flex flex-col shadow-2xl animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-700">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Cleanup Queue</h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Closed workspaces with failed worktree removal
            </p>
          </div>
          <div className="flex items-center gap-2">
            {pendingCount > 1 && (
              <button
                onClick={handleRetryAll}
                disabled={retryingId != null}
                className="px-3 py-1.5 text-xs rounded bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white font-medium"
              >
                Retry All ({pendingCount})
              </button>
            )}
            <button
              onClick={fetchWarnings}
              disabled={loading}
              className="px-3 py-1.5 text-xs rounded bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-zinc-200"
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
            <button
              onClick={onClose}
              className="text-zinc-400 hover:text-zinc-200 text-xl leading-none"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {loading && entries.length === 0 && (
            <div className="text-zinc-400 text-sm text-center py-12">Loading…</div>
          )}

          {fetchError && (
            <div className="bg-red-900/40 border border-red-700 rounded px-4 py-3 text-sm text-red-300">
              {fetchError}
            </div>
          )}

          {!loading && !fetchError && entries.length === 0 && (
            <div className="text-zinc-500 text-sm text-center py-12">
              No cleanup warnings — all worktrees removed successfully.
            </div>
          )}

          {entries.map((entry) => {
            const isRetrying = retryingId === entry.id;
            const retryError = retryErrors[entry.id];
            const succeeded = retrySucceeded.has(entry.id);
            const age = ageOf(entry);

            return (
              <div
                key={entry.id}
                className="bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono text-zinc-400">#{entry.issueNumber}</span>
                      <span className="text-sm font-medium text-zinc-100 truncate">
                        {entry.issueTitle || entry.branch}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5 truncate font-mono">
                      {entry.workingDir ?? entry.branch}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {age && (
                      <span className="text-xs text-zinc-500">
                        {formatRelativeTime(age)}
                      </span>
                    )}
                    {!succeeded && (
                      <button
                        onClick={() => handleRetry(entry.id)}
                        disabled={isRetrying || retryingId != null}
                        className="px-3 py-1.5 text-xs rounded bg-orange-700 hover:bg-orange-600 disabled:opacity-50 text-white font-medium whitespace-nowrap"
                      >
                        {isRetrying ? "Retrying…" : "Retry Cleanup"}
                      </button>
                    )}
                    {succeeded && (
                      <span className="text-xs text-green-400 font-medium">Cleaned up</span>
                    )}
                  </div>
                </div>

                <div className="bg-zinc-900 rounded px-3 py-2 text-xs text-amber-300 font-mono break-all">
                  {entry.cleanupWarning}
                </div>

                {retryError && (
                  <div className="text-xs text-red-400 bg-red-900/30 rounded px-2 py-1">
                    {retryError}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
