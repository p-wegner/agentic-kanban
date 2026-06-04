import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import type { DiffResponse } from "@agentic-kanban/shared";
import { DiffViewer } from "./DiffViewer.js";

interface WorkspaceAttempt {
  id: string;
  branch: string;
  status: "active" | "reviewing" | "fixing" | "idle" | "awaiting-plan-approval" | "error" | "closed";
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  diffStats: { filesChanged: number; insertions: number; deletions: number } | null;
  scorecard: { score: number } | null;
  sessionStatus: string | null;
  lastSessionAt: string | null;
  lastSessionTriggerType: string | null;
  commitCount?: number | null;
  skillName?: string | null;
  model?: string | null;
}

interface CompareAttemptsPanelProps {
  issueId: string;
  onClose: () => void;
  onOpenWorkspace: (workspaceId: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  reviewing: "bg-accent-50 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300",
  fixing: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  idle: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  "awaiting-plan-approval": "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  error: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  closed: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
};

const SESSION_STATUS_LABELS: Record<string, string> = {
  running: "Running",
  stopped: "Stopped",
  completed: "Completed",
  error: "Error",
};

function scoreColor(score: number): string {
  if (score >= 80) return "text-green-600 dark:text-green-400";
  if (score >= 60) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function AttemptDiff({ workspaceId }: { workspaceId: string }) {
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<DiffResponse>(`/api/workspaces/${workspaceId}/diff`)
      .then(d => { if (!cancelled) { setDiff(d); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  if (loading) return <div className="text-xs text-gray-400 italic py-1">Loading diff...</div>;
  if (!diff || !diff.diff) return <div className="text-xs text-gray-400 italic py-1">No changes</div>;

  return (
    <div>
      <button
        onClick={() => setExpanded(v => !v)}
        className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
      >
        {expanded ? "Hide diff" : `View diff (${diff.stats.filesChanged} file${diff.stats.filesChanged !== 1 ? "s" : ""})`}
      </button>
      {expanded && (
        <div className="mt-2 max-h-72 overflow-y-auto rounded border border-gray-200 dark:border-gray-700 text-xs">
          <DiffViewer diff={diff.diff} stats={diff.stats} comments={[]} />
        </div>
      )}
    </div>
  );
}

export function CompareAttemptsPanel({ issueId, onClose, onOpenWorkspace }: CompareAttemptsPanelProps) {
  const [attempts, setAttempts] = useState<WorkspaceAttempt[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch<WorkspaceAttempt[]>(`/api/issues/${issueId}/workspaces`)
      .then(ws => { if (!cancelled) { setAttempts(ws); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [issueId]);

  const sorted = [...attempts].sort((a, b) => {
    // Merged first, then by created desc
    if (a.mergedAt && !b.mergedAt) return -1;
    if (!a.mergedAt && b.mergedAt) return 1;
    return b.createdAt.localeCompare(a.createdAt);
  });

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-5xl border border-gray-200 dark:border-gray-700 flex flex-col max-h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              Compare workspace attempts
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {loading ? "Loading..." : `${sorted.length} attempt${sorted.length !== 1 ? "s" : ""} — select the best one to merge`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none p-1"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-gray-400">
              <svg className="animate-spin h-6 w-6 mr-2" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
              Loading attempts...
            </div>
          ) : sorted.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No workspaces found.</p>
          ) : (
            <div className="space-y-3">
              {sorted.map((attempt, idx) => {
                const isMerged = !!attempt.mergedAt;
                const isActive = attempt.status !== "closed";

                return (
                  <div
                    key={attempt.id}
                    className={`rounded-lg border p-4 ${
                      isMerged
                        ? "border-green-400 dark:border-green-700 bg-green-50 dark:bg-green-900/10"
                        : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {/* Attempt number */}
                      <div className="shrink-0 w-7 h-7 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-xs font-bold text-gray-600 dark:text-gray-300 mt-0.5">
                        {idx + 1}
                      </div>

                      <div className="flex-1 min-w-0">
                        {/* Top row: branch + status + merged badge */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-sm text-gray-800 dark:text-gray-200 truncate max-w-[300px]" title={attempt.branch}>
                            {attempt.branch}
                          </span>
                          <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded shrink-0 ${STATUS_COLORS[attempt.status] ?? STATUS_COLORS.closed}`}>
                            {attempt.status}
                          </span>
                          {isMerged && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300 shrink-0">
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                              Merged
                            </span>
                          )}
                        </div>

                        {/* Metrics row */}
                        <div className="flex items-center gap-4 mt-1.5 flex-wrap text-xs text-gray-500 dark:text-gray-400">
                          {/* Diff stats */}
                          {attempt.diffStats ? (
                            <span className="flex items-center gap-1">
                              <span className="text-gray-400">{attempt.diffStats.filesChanged} file{attempt.diffStats.filesChanged !== 1 ? "s" : ""}</span>
                              <span className="text-green-600 dark:text-green-400">+{attempt.diffStats.insertions}</span>
                              <span className="text-red-500 dark:text-red-400">-{attempt.diffStats.deletions}</span>
                            </span>
                          ) : (
                            <span className="text-gray-300 dark:text-gray-600">no diff stats</span>
                          )}

                          {/* Scorecard */}
                          {attempt.scorecard !== null && attempt.scorecard !== undefined && (
                            <span className="flex items-center gap-1">
                              <span className="text-gray-400">Score:</span>
                              <span className={`font-semibold ${scoreColor(attempt.scorecard.score)}`}>
                                {attempt.scorecard.score}
                              </span>
                            </span>
                          )}

                          {/* Session outcome */}
                          {attempt.sessionStatus && (
                            <span className="flex items-center gap-1">
                              <span className="text-gray-400">Last session:</span>
                              <span className={
                                attempt.sessionStatus === "completed" ? "text-green-600 dark:text-green-400" :
                                attempt.sessionStatus === "error" ? "text-red-500" :
                                attempt.sessionStatus === "running" ? "text-blue-500" :
                                "text-gray-500"
                              }>
                                {SESSION_STATUS_LABELS[attempt.sessionStatus] ?? attempt.sessionStatus}
                              </span>
                              {attempt.lastSessionAt && (
                                <span className="text-gray-400">({formatRelativeTime(attempt.lastSessionAt)})</span>
                              )}
                            </span>
                          )}

                          {/* Skill */}
                          {attempt.skillName && (
                            <span className="flex items-center gap-1">
                              <span className="text-gray-400">Skill:</span>
                              <span className="text-gray-600 dark:text-gray-300">{attempt.skillName}</span>
                            </span>
                          )}

                          {/* Created */}
                          <span className="flex items-center gap-1">
                            <span className="text-gray-400">Created:</span>
                            <span>{formatRelativeTime(attempt.createdAt)}</span>
                          </span>

                          {/* Merged / closed at */}
                          {attempt.mergedAt && (
                            <span className="flex items-center gap-1">
                              <span className="text-gray-400">Merged:</span>
                              <span className="text-green-600 dark:text-green-400">{formatRelativeTime(attempt.mergedAt)}</span>
                            </span>
                          )}
                          {!attempt.mergedAt && attempt.closedAt && (
                            <span className="flex items-center gap-1">
                              <span className="text-gray-400">Closed:</span>
                              <span>{formatRelativeTime(attempt.closedAt)}</span>
                            </span>
                          )}
                        </div>

                        {/* Diff viewer */}
                        <div className="mt-2">
                          <AttemptDiff workspaceId={attempt.id} />
                        </div>
                      </div>

                      {/* Open workspace button */}
                      {isActive && (
                        <button
                          onClick={() => { onOpenWorkspace(attempt.id); onClose(); }}
                          className="shrink-0 text-xs font-medium px-2.5 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                        >
                          Open
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 shrink-0 flex items-center justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
