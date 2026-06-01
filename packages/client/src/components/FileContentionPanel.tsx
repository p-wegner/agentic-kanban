import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../lib/api.js";

interface ContentionWorkspace {
  workspaceId: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  branch: string;
  status: string;
  issueStatus: string;
}

interface ContentionFile {
  path: string;
  workspaces: ContentionWorkspace[];
}

interface FileContentionResult {
  projectId: string;
  defaultBranch: string | null;
  contested: ContentionFile[];
  checkedAt: string;
}

interface FileContentionPanelProps {
  activeProjectId: string | null;
  onClose: () => void;
}

const WS_STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  reviewing: "bg-accent-50 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300",
  fixing: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  idle: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  closed: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
};

const ISSUE_STATUS_COLORS: Record<string, string> = {
  "Todo": "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
  "In Progress": "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  "In Review": "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  "AI Reviewed": "bg-accent-50 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300",
  "Done": "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  "Cancelled": "bg-red-100 text-red-500 dark:bg-red-900/40 dark:text-red-300",
};

function FileIcon() {
  return (
    <svg className="h-4 w-4 text-gray-500 dark:text-gray-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function HeatIcon() {
  return (
    <svg className="h-5 w-5 text-gray-600 dark:text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

function contention2Color(count: number): string {
  if (count >= 4) return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
  if (count === 3) return "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300";
  return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300";
}

export function FileContentionPanel({ activeProjectId, onClose }: FileContentionPanelProps) {
  const [data, setData] = useState<FileContentionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const load = useCallback(() => {
    if (!activeProjectId) return;
    setLoading(true);
    setError(null);
    apiFetch<FileContentionResult>(`/api/projects/${activeProjectId}/file-contention`)
      .then((result) => {
        setData(result);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [activeProjectId]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = data
    ? data.contested.filter((f) =>
        !searchQuery || f.path.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-[min(560px,100vw)] bg-surface-raised dark:bg-surface-raised-dark shadow-xl flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <HeatIcon />
            <h2 className="text-lg font-semibold text-ink dark:text-stone-100 heading-serif">File Contention</h2>
            {!loading && data && (
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {searchQuery
                  ? `${filtered.length} of ${data.contested.length} contested`
                  : data.contested.length === 0
                    ? "No overlap"
                    : `${data.contested.length} contested file${data.contested.length === 1 ? "" : "s"}`}
              </span>
            )}
            {loading && (
              <span className="text-sm text-gray-400 dark:text-gray-500">Loading…</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={load}
              disabled={loading}
              title="Refresh"
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-40 text-sm px-1.5 py-0.5 rounded"
            >
              ↻
            </button>
            <button
              onClick={onClose}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800">
          <input
            type="text"
            placeholder="Filter by file path…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full text-sm px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-400 bg-white dark:bg-gray-900 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600"
          />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {!activeProjectId && (
            <div className="flex flex-col items-center justify-center h-48 text-gray-400 dark:text-gray-500 gap-2">
              <span className="text-sm">No active project selected.</span>
            </div>
          )}

          {activeProjectId && error && (
            <div className="flex flex-col items-center justify-center h-48 text-red-500 dark:text-red-400 gap-2 px-6 text-center">
              <span className="text-sm">{error}</span>
              <button
                onClick={load}
                className="text-xs underline text-red-400 hover:text-red-600"
              >
                Retry
              </button>
            </div>
          )}

          {activeProjectId && !loading && !error && data && data.contested.length === 0 && (
            <div className="flex flex-col items-center justify-center h-48 text-gray-400 dark:text-gray-500 gap-3 px-6 text-center">
              <svg className="h-10 w-10 text-gray-300 dark:text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M9 12l2 2 4-4" />
                <circle cx="12" cy="12" r="10" />
              </svg>
              <div>
                <p className="text-sm font-medium">No file contention</p>
                <p className="text-xs mt-1">Active and In Review workspaces touch distinct files.</p>
              </div>
            </div>
          )}

          {activeProjectId && !loading && !error && data && filtered.length === 0 && data.contested.length > 0 && (
            <div className="flex items-center justify-center h-24 text-gray-400 dark:text-gray-500">
              <span className="text-sm">No files match "{searchQuery}"</span>
            </div>
          )}

          {activeProjectId && !error && filtered.length > 0 && (
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {filtered.map((file) => (
                <li key={file.path} className="px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  {/* File path + contention badge */}
                  <div className="flex items-start gap-2 mb-2">
                    <FileIcon />
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-mono text-gray-800 dark:text-gray-200 break-all leading-relaxed">
                        {file.path}
                      </span>
                    </div>
                    <span
                      className={`text-xs font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${contention2Color(file.workspaces.length)}`}
                      title={`${file.workspaces.length} workspaces touch this file`}
                    >
                      {file.workspaces.length}×
                    </span>
                  </div>

                  {/* Workspaces touching this file */}
                  <ul className="space-y-1 pl-6">
                    {file.workspaces.map((ws) => (
                      <li
                        key={ws.workspaceId}
                        className="flex items-center gap-1.5 flex-wrap"
                      >
                        {ws.issueNumber !== null && (
                          <span className="text-xs font-mono font-medium text-gray-500 dark:text-gray-400">
                            #{ws.issueNumber}
                          </span>
                        )}
                        <span className="text-xs text-gray-700 dark:text-gray-300 truncate max-w-[180px]" title={ws.issueTitle}>
                          {ws.issueTitle}
                        </span>
                        <span
                          className={`text-[10px] font-medium px-1 py-0.5 rounded capitalize ${WS_STATUS_COLORS[ws.status] ?? "bg-gray-100 text-gray-500"}`}
                        >
                          {ws.status}
                        </span>
                        <span
                          className={`text-[10px] font-medium px-1 py-0.5 rounded ${ISSUE_STATUS_COLORS[ws.issueStatus] ?? "bg-gray-100 text-gray-500"}`}
                        >
                          {ws.issueStatus}
                        </span>
                        <span className="text-[10px] font-mono text-gray-400 dark:text-gray-500 truncate max-w-[140px]" title={ws.branch}>
                          {ws.branch}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        {data && (
          <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-800 text-xs text-gray-400 dark:text-gray-500">
            Checked {new Date(data.checkedAt).toLocaleTimeString('en-US')} · read-only
          </div>
        )}
      </div>
    </div>
  );
}
