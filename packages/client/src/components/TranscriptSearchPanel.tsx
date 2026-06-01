import { useState, useCallback } from "react";
import { apiFetch } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";

interface SearchResult {
  messageId: number;
  sessionId: string;
  snippet: string;
  matchOffset: number;
  messageCreatedAt: string;
  workspaceId: string;
  branch: string;
  workspaceStatus: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  issueStatusName: string;
  sessionStartedAt: string;
  sessionStatus: string;
  executor: string;
}

interface SearchResponse {
  results: SearchResult[];
  totalMatches: number;
}

interface TranscriptSearchPanelProps {
  projectId: string;
  onClose: () => void;
  onNavigateToWorkspace: (issueId: string, workspaceId: string, sessionId: string) => void;
}

const STATUS_FILTERS = [
  { label: "All", value: "" },
  { label: "Active", value: "In Progress" },
  { label: "In Review", value: "In Review" },
  { label: "Done", value: "Done" },
];

const PROVIDER_FILTERS = [
  { label: "All", value: "" },
  { label: "Claude", value: "claude-code" },
  { label: "Codex", value: "codex" },
  { label: "Copilot", value: "copilot" },
];

const ISSUE_STATUS_COLORS: Record<string, string> = {
  "Todo": "bg-gray-100 text-gray-600",
  "In Progress": "bg-blue-100 text-blue-700",
  "In Review": "bg-orange-100 text-orange-700",
  "AI Reviewed": "bg-accent-50 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300",
  "Done": "bg-green-100 text-green-700",
  "Cancelled": "bg-red-100 text-red-500",
};

function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  if (!query) return <span>{text}</span>;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return <span>{text}</span>;

  return (
    <span>
      {text.slice(0, idx)}
      <mark className="bg-yellow-200 dark:bg-yellow-800/60 text-inherit rounded-sm px-0.5">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </span>
  );
}

export function TranscriptSearchPanel({ projectId, onClose, onNavigateToWorkspace }: TranscriptSearchPanelProps) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        q: trimmed,
        projectId,
        limit: "50",
      });
      if (statusFilter) params.set("status", statusFilter);
      if (providerFilter) params.set("provider", providerFilter);

      const data = await apiFetch<SearchResponse>(`/api/sessions/search?${params}`);
      setResults(data.results);
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }, [query, projectId, statusFilter, providerFilter]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      doSearch();
    }
    if (e.key === "Escape") {
      onClose();
    }
  }

  // Group results by issue
  const grouped = results.reduce<Record<string, { issue: { id: string; number: number | null; title: string; statusName: string }; items: SearchResult[] }>>((acc, r) => {
    const key = r.issueId;
    if (!acc[key]) {
      acc[key] = {
        issue: { id: r.issueId, number: r.issueNumber, title: r.issueTitle, statusName: r.issueStatusName },
        items: [],
      };
    }
    acc[key].items.push(r);
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-[min(560px,100vw)] bg-surface-raised dark:bg-surface-raised-dark shadow-xl flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <svg className="h-5 w-5 text-gray-600 dark:text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <h2 className="text-lg font-semibold text-ink dark:text-stone-100 heading-serif">Transcript Search</h2>
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {searched && !loading ? `${results.length} result${results.length !== 1 ? "s" : ""}` : ""}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
          >
            &times;
          </button>
        </div>

        {/* Search controls */}
        <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 space-y-2">
          {/* Search input */}
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Search agent transcripts (min 2 chars)…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 text-sm px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-400 dark:bg-gray-900 dark:text-gray-200"
              autoFocus
            />
            <button
              onClick={doSearch}
              disabled={loading || query.trim().length < 2}
              className="px-3 py-1.5 text-sm font-medium rounded-md bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "…" : "Search"}
            </button>
          </div>

          {/* Filters */}
          <div className="flex gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500 dark:text-gray-400">Status:</span>
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setStatusFilter(f.value)}
                  className={`text-xs px-2 py-0.5 rounded-full font-medium transition-colors ${
                    statusFilter === f.value
                      ? "bg-brand-600 text-white"
                      : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500 dark:text-gray-400">Provider:</span>
              {PROVIDER_FILTERS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setProviderFilter(f.value)}
                  className={`text-xs px-2 py-0.5 rounded-full font-medium transition-colors ${
                    providerFilter === f.value
                      ? "bg-brand-600 text-white"
                      : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="px-4 py-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-b border-red-100 dark:border-red-800">
              {error}
            </div>
          )}

          {loading && (
            <div className="px-4 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
              Searching transcripts…
            </div>
          )}

          {!loading && searched && results.length === 0 && (
            <div className="px-4 py-12 text-center text-sm text-gray-500 dark:text-gray-400">
              No transcripts found matching "{query.trim()}"
            </div>
          )}

          {!loading && !searched && (
            <div className="px-4 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
              <svg className="w-12 h-12 mx-auto mb-3 opacity-25" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              Search across all agent session transcripts to find errors, decisions, file references, and commands.
            </div>
          )}

          {!loading && results.length > 0 && Object.entries(grouped).map(([issueId, group]) => (
            <div key={issueId} className="border-b border-gray-100 dark:border-gray-800">
              {/* Issue header */}
              <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-2 sticky top-0 z-10">
                <span className="text-xs text-gray-400 dark:text-gray-500 font-mono">
                  #{group.issue.number ?? "?"}
                </span>
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate flex-1 min-w-0">
                  {group.issue.title}
                </span>
                <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${ISSUE_STATUS_COLORS[group.issue.statusName] ?? "bg-gray-100 text-gray-600"}`}>
                  {group.issue.statusName}
                </span>
              </div>

              {/* Result items */}
              {group.items.map((item) => (
                <div
                  key={`${item.sessionId}-${item.messageId}`}
                  className="px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer border-b border-gray-50 dark:border-gray-800/50 last:border-b-0"
                  onClick={() => onNavigateToWorkspace(item.issueId, item.workspaceId, item.sessionId)}
                >
                  {/* Snippet */}
                  <div className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed line-clamp-3 mb-1.5 font-mono text-xs whitespace-pre-wrap break-all">
                    <HighlightedSnippet text={item.snippet} query={query.trim()} />
                  </div>

                  {/* Context line */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate max-w-[180px]">
                      {item.branch}
                    </span>
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      {formatRelativeTime(item.messageCreatedAt)}
                    </span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                      {item.executor}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
