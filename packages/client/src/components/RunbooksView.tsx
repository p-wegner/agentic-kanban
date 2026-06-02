import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { apiFetch } from "../lib/api.js";

interface RunbookEntry {
  path: string;
  title: string;
  lastModified: string;
}

interface RunbookContent {
  path: string;
  title: string;
  lastModified: string;
  content: string;
}

interface RunbooksViewProps {
  projectId: string | null;
}

function formatRelativeTime(iso: string): string {
  try {
    const date = new Date(iso);
    const diffMs = Date.now() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay > 30) {
      return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    }
    if (diffDay > 0) return `${diffDay}d ago`;
    if (diffHr > 0) return `${diffHr}h ago`;
    if (diffMin > 0) return `${diffMin}m ago`;
    return "just now";
  } catch {
    return iso;
  }
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  );
}

export function RunbooksView({ projectId }: RunbooksViewProps) {
  const [entries, setEntries] = useState<RunbookEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<RunbookEntry | null>(null);
  const [content, setContent] = useState<RunbookContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  const fetchEntries = useCallback(async () => {
    if (!projectId) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<RunbookEntry[]>(`/api/projects/${projectId}/runbooks`);
      setEntries(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load runbooks");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setEntries([]);
    setSelectedEntry(null);
    setContent(null);
    setContentError(null);
    fetchEntries();
  }, [fetchEntries]);

  const handleSelect = useCallback(async (entry: RunbookEntry) => {
    setSelectedEntry(entry);
    setContentLoading(true);
    setContentError(null);
    setContent(null);
    try {
      const data = await apiFetch<RunbookContent>(
        `/api/projects/${projectId}/runbooks/content?path=${encodeURIComponent(entry.path)}`,
      );
      setContent(data);
    } catch (e) {
      setContentError(e instanceof Error ? e.message : "Failed to load content");
    } finally {
      setContentLoading(false);
    }
  }, [projectId]);

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar */}
      <div className="w-72 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-blue-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
            </svg>
            <span className="font-semibold text-sm text-gray-900 dark:text-gray-100">Runbooks</span>
            {entries.length > 0 && (
              <span className="text-xs bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded-full font-medium">
                {entries.length}
              </span>
            )}
          </div>
          <button
            onClick={fetchEntries}
            disabled={loading}
            className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 disabled:opacity-40"
            title="Refresh"
          >
            <SpinnerIcon className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center h-24 text-gray-400 dark:text-gray-600">
              <SpinnerIcon className="w-5 h-5 animate-spin" />
            </div>
          )}

          {!loading && error && (
            <div className="m-3 p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          {!loading && !error && entries.length === 0 && (
            <div className="flex flex-col items-center justify-center h-32 text-gray-400 dark:text-gray-600 text-xs gap-2 px-4 text-center">
              <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
              No runbook files found
            </div>
          )}

          {!loading && !error && entries.map((entry) => {
            const isSelected = selectedEntry?.path === entry.path;
            return (
              <button
                key={entry.path}
                onClick={() => handleSelect(entry)}
                className={[
                  "w-full text-left px-4 py-3 border-b border-gray-100 dark:border-gray-800",
                  "hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors",
                  isSelected
                    ? "bg-blue-50 dark:bg-blue-950 border-l-2 border-l-blue-500"
                    : "",
                ].join(" ")}
              >
                <div className={`text-sm font-semibold truncate ${isSelected ? "text-blue-700 dark:text-blue-300" : "text-gray-900 dark:text-gray-100"}`}>
                  {entry.title}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate font-mono">
                  {entry.path}
                </div>
                <div className="text-xs text-gray-400 dark:text-gray-600 mt-0.5">
                  {formatRelativeTime(entry.lastModified)}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selectedEntry && (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-400 dark:text-gray-600 gap-3">
            <svg className="w-10 h-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
            </svg>
            <p className="text-sm">Select a runbook from the left panel</p>
          </div>
        )}

        {selectedEntry && (
          <>
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 shrink-0">
              <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {selectedEntry.title}
              </h1>
              <p className="text-xs text-gray-500 dark:text-gray-400 font-mono mt-1">
                {selectedEntry.path}
                {" "}
                <span className="text-gray-400 dark:text-gray-600">&middot; modified {formatRelativeTime(selectedEntry.lastModified)}</span>
              </p>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {contentLoading && (
                <div className="flex items-center justify-center h-24 text-gray-400 dark:text-gray-600">
                  <SpinnerIcon className="w-5 h-5 animate-spin" />
                </div>
              )}

              {!contentLoading && contentError && (
                <div className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300">
                  {contentError}
                </div>
              )}

              {!contentLoading && !contentError && content !== null && (
                <div className="markdown-body">
                  <ReactMarkdown>{content.content}</ReactMarkdown>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
