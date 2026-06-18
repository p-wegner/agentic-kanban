import { useState, useEffect, useCallback, useMemo } from "react";
import { apiFetch, apiPost } from "../lib/api.js";
import { getSettings, setSettings } from "../lib/settingsStore.js";
import type { StatusWithIssues, IssueWithStatus } from "@agentic-kanban/shared";

interface StaleWorkDashboardProps {
  projectId: string;
  onIssueClick?: (issue: IssueWithStatus) => void;
}

interface NudgeState {
  [issueId: string]: "idle" | "loading" | "done" | "error";
}

const PREF_KEY = "stale_column_threshold_days";
const DEFAULT_THRESHOLD = 2;

export function StaleWorkDashboard({ projectId, onIssueClick }: StaleWorkDashboardProps) {
  const [columns, setColumns] = useState<StatusWithIssues[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [thresholdInput, setThresholdInput] = useState(String(DEFAULT_THRESHOLD));
  const [nudgeState, setNudgeState] = useState<NudgeState>({});

  useEffect(() => {
    getSettings()
      .then((settings) => {
        const val = parseInt(settings[PREF_KEY] ?? "", 10);
        if (!isNaN(val) && val > 0) {
          setThreshold(val);
          setThresholdInput(String(val));
        }
      })
      .catch(() => {});
  }, []);

  const fetchBoard = useCallback(() => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    apiFetch<StatusWithIssues[]>(`/api/projects/${projectId}/board`)
      .then((data) => {
        setColumns(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load board data");
        setLoading(false);
      });
  }, [projectId]);

  useEffect(() => {
    fetchBoard();
  }, [fetchBoard]);

  const staleIssues = useMemo(() => {
    const result: IssueWithStatus[] = [];
    for (const col of columns) {
      for (const issue of col.issues) {
        const age = issue.columnAgeDays ?? 0;
        if (age >= threshold) {
          result.push(issue);
        }
      }
    }
    result.sort((a, b) => (b.columnAgeDays ?? 0) - (a.columnAgeDays ?? 0));
    return result;
  }, [columns, threshold]);

  const groupedByStatus = useMemo(() => {
    const groups = new Map<string, IssueWithStatus[]>();
    for (const issue of staleIssues) {
      const name = issue.statusName;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(issue);
    }
    return groups;
  }, [staleIssues]);

  const handleThresholdChange = useCallback((value: string) => {
    setThresholdInput(value);
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed) && parsed > 0) {
      setThreshold(parsed);
      setSettings({ [PREF_KEY]: String(parsed) }).catch(() => {});
    }
  }, []);

  const handleNudge = useCallback(
    async (issue: IssueWithStatus) => {
      const wsId = issue.workspaceSummary?.main?.id;
      if (!wsId) return;
      setNudgeState((prev) => ({ ...prev, [issue.id]: "loading" }));
      try {
        await apiPost(`/api/workspaces/${wsId}/turn`, {
            content: `Nudge: this issue (#${issue.issueNumber ?? issue.id}) has been stuck in "${issue.statusName}" for ${issue.columnAgeDays ?? 0} day(s). Please review current progress and either continue work or summarize the blocker.`,
          });
        setNudgeState((prev) => ({ ...prev, [issue.id]: "done" }));
      } catch {
        setNudgeState((prev) => ({ ...prev, [issue.id]: "error" }));
      }
    },
    [],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500 dark:text-gray-400">
        <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        Loading stale issues...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2 text-red-500">
        <span>{error}</span>
        <button
          onClick={fetchBoard}
          className="px-3 py-1 text-sm rounded bg-red-100 dark:bg-red-900/30 hover:bg-red-200 dark:hover:bg-red-900/50 text-red-700 dark:text-red-300"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-auto">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Stale Work</h2>
        </div>
        <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
          <label htmlFor="stale-threshold" className="whitespace-nowrap">
            Stuck longer than
          </label>
          <input
            id="stale-threshold"
            type="number"
            min={1}
            value={thresholdInput}
            onChange={(e) => handleThresholdChange(e.target.value)}
            className="w-14 px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm text-center"
          />
          <span>day(s)</span>
        </div>
        <div className="ml-auto flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <span>
            {staleIssues.length} issue{staleIssues.length !== 1 ? "s" : ""} stale
          </span>
          <button
            onClick={fetchBoard}
            title="Refresh"
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {staleIssues.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-2 text-gray-400 dark:text-gray-500">
          <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm">No issues stuck longer than {threshold} day(s)</span>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {Array.from(groupedByStatus.entries()).map(([statusName, issues]) => (
            <div key={statusName} className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
                <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  {statusName}
                </span>
                <span className="ml-auto text-xs font-medium text-gray-400 dark:text-gray-500 bg-gray-200 dark:bg-gray-700 rounded-full px-2 py-0.5">
                  {issues.length}
                </span>
              </div>
              <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {issues.map((issue) => {
                  const ns = nudgeState[issue.id] ?? "idle";
                  const hasWorkspace =
                    issue.workspaceSummary?.main != null &&
                    issue.workspaceSummary.main.status !== "closed";
                  const age = issue.columnAgeDays ?? 0;
                  return (
                    <div
                      key={issue.id}
                      className="flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800/40 group"
                    >
                      <button
                        className="flex-1 min-w-0 text-left"
                        onClick={() => onIssueClick?.(issue)}
                        title="Open issue"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {issue.issueNumber != null && (
                            <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
                              #{issue.issueNumber}
                            </span>
                          )}
                          <span className="text-sm text-gray-800 dark:text-gray-200 truncate">
                            {issue.title}
                          </span>
                        </div>
                      </button>
                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                            age >= 7
                              ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                              : age >= 3
                                ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                                : "bg-yellow-50 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400"
                          }`}
                          title={`Stuck for ${age} day(s)`}
                        >
                          {age}d
                        </span>
                        {hasWorkspace ? (
                          <button
                            onClick={() => handleNudge(issue)}
                            disabled={ns === "loading" || ns === "done"}
                            title={
                              ns === "done"
                                ? "Nudge sent"
                                : ns === "error"
                                  ? "Nudge failed — click to retry"
                                  : "Send a nudge to the active workspace"
                            }
                            className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                              ns === "done"
                                ? "border-green-300 bg-green-50 text-green-700 dark:border-green-700 dark:bg-green-900/20 dark:text-green-400 cursor-default"
                                : ns === "error"
                                  ? "border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-900/20 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40"
                                  : ns === "loading"
                                    ? "border-gray-300 text-gray-400 cursor-wait"
                                    : "border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-700 dark:hover:bg-indigo-900/20 dark:hover:border-indigo-600 dark:hover:text-indigo-400 opacity-0 group-hover:opacity-100 focus:opacity-100"
                            }`}
                          >
                            {ns === "loading" ? "..." : ns === "done" ? "Sent" : ns === "error" ? "Retry" : "Nudge"}
                          </button>
                        ) : (
                          <button
                            onClick={() => onIssueClick?.(issue)}
                            title="Open issue (no active workspace to nudge)"
                            className="text-xs px-2 py-0.5 rounded border border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100 focus:opacity-100"
                          >
                            Open
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
