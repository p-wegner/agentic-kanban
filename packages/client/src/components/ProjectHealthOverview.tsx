import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";

interface ProjectHealth {
  id: string;
  name: string;
  color: string | null;
  repoPath: string;
  defaultBranch: string | null;
  issueCounts: Record<string, number>;
  totalIssues: number;
  warnings: string[];
}

interface ProjectHealthData {
  projects: ProjectHealth[];
  activeProjectId: string | null;
}

interface ProjectHealthOverviewProps {
  activeProjectId: string | null;
  onProjectChange: (id: string) => void;
  onClose: () => void;
}

export function ProjectHealthOverview({ activeProjectId, onProjectChange, onClose }: ProjectHealthOverviewProps) {
  const [data, setData] = useState<ProjectHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch<ProjectHealthData>("/api/projects/health");
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load project health");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-16 px-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-2xl rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Project Health Overview</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={load}
              className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-2 py-1 rounded"
              title="Refresh"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              aria-label="Close project health overview"
            >
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 p-4">
          {loading && (
            <div className="flex items-center justify-center py-12 text-gray-400">
              <svg className="animate-spin h-5 w-5 mr-2" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Loading...
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </div>
          )}

          {!loading && !error && data && (
            <div className="space-y-2">
              {data.projects.length === 0 && (
                <p className="text-center py-8 text-gray-400 text-sm">No projects registered.</p>
              )}
              {data.projects.map((project) => {
                const isActive = project.id === activeProjectId;
                const hasWarnings = project.warnings.length > 0;
                return (
                  <div
                    key={project.id}
                    className={`rounded-lg border p-4 transition-colors ${
                      isActive
                        ? "border-brand-400 bg-brand-50 dark:border-brand-600 dark:bg-brand-950/30"
                        : "border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/40"
                    } ${hasWarnings ? "border-l-4 border-l-amber-400 dark:border-l-amber-500" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          {project.color && (
                            <span
                              className="h-2.5 w-2.5 rounded-full shrink-0 border border-black/10 dark:border-white/20"
                              style={{ backgroundColor: project.color }}
                            />
                          )}
                          <span className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">
                            {project.name}
                          </span>
                          {isActive && (
                            <span className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium bg-brand-100 text-brand-700 dark:bg-brand-900 dark:text-brand-200">
                              active
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-400 dark:text-gray-500 truncate mb-2" title={project.repoPath}>
                          {project.repoPath}
                          {project.defaultBranch && (
                            <span className="ml-2 text-gray-500 dark:text-gray-400">
                              on <span className="font-mono">{project.defaultBranch}</span>
                            </span>
                          )}
                        </div>
                        <IssueCounts counts={project.issueCounts} total={project.totalIssues} />
                        {hasWarnings && (
                          <div className="mt-2 space-y-1">
                            {project.warnings.map((warning, i) => (
                              <div key={i} className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                                <svg className="h-3.5 w-3.5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                </svg>
                                <span>{warning}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      {!isActive && (
                        <button
                          type="button"
                          onClick={() => { onProjectChange(project.id); onClose(); }}
                          className="shrink-0 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                        >
                          Switch
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function IssueCounts({ counts, total }: { counts: Record<string, number>; total: number }) {
  if (total === 0) {
    return <span className="text-xs text-gray-400 dark:text-gray-500">No issues</span>;
  }

  const STATUS_COLORS: Record<string, string> = {
    Backlog: "bg-gray-400",
    "In Progress": "bg-blue-500",
    "In Review": "bg-violet-500",
    "AI Reviewed": "bg-purple-500",
    Done: "bg-green-500",
    Cancelled: "bg-gray-300",
  };

  const entries = Object.entries(counts).filter(([, n]) => n > 0);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {entries.map(([status, count]) => (
        <span key={status} className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
          <span className={`h-1.5 w-1.5 rounded-full ${STATUS_COLORS[status] ?? "bg-gray-400"}`} />
          {count} {status}
        </span>
      ))}
      <span className="text-xs text-gray-400 dark:text-gray-500">({total} total)</span>
    </div>
  );
}
