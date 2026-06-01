import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";

export type BoardHealthEventCategory = "merge" | "launch" | "server" | "refill" | "smoke_check";

export interface BoardHealthEvent {
  id: string;
  timestamp: string;
  level: "info" | "error";
  type: "cycle_start" | "cycle_end" | "observation" | "action" | "error";
  category: BoardHealthEventCategory | null;
  issueNumber: number | null;
  summary: string;
  details: string | null;
}

type CategoryFilter = "all" | BoardHealthEventCategory;

const CATEGORY_OPTIONS: { value: CategoryFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "merge", label: "Merge" },
  { value: "launch", label: "Launch" },
  { value: "server", label: "Server" },
  { value: "refill", label: "Refill" },
  { value: "smoke_check", label: "Smoke check" },
];

const CATEGORY_BADGE_CLASSES: Record<BoardHealthEventCategory, string> = {
  merge: "bg-brand-100 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300",
  launch: "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300",
  server: "bg-violet-100 dark:bg-violet-900 text-violet-700 dark:text-violet-300",
  refill: "bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300",
  smoke_check: "bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300",
};

const LEVEL_DOT_CLASSES: Record<BoardHealthEvent["level"], string> = {
  info: "bg-sky-400",
  error: "bg-red-500",
};

function formatAge(isoStr: string): string {
  const s = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatTimestamp(isoStr: string): string {
  return new Date(isoStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

interface BoardHealthNotificationCenterProps {
  projectId: string | null;
  onOpenIssue?: (issueNumber: number) => void;
}

export function BoardHealthNotificationCenter({ projectId, onOpenIssue }: BoardHealthNotificationCenterProps) {
  const [events, setEvents] = useState<BoardHealthEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [limit, setLimit] = useState(50);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchEvents = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      const data = await apiFetch<BoardHealthEvent[]>(`/api/projects/${projectId}/board-health-events?${params}`);
      setEvents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load events");
    } finally {
      setLoading(false);
    }
  }, [projectId, categoryFilter, limit]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400 dark:text-gray-500 text-sm">
        No project selected
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
          </svg>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Board Health Events</h2>
          {!loading && events.length > 0 && (
            <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 text-[11px] font-medium">
              {events.length}
            </span>
          )}
        </div>
        <button
          onClick={fetchEvents}
          disabled={loading}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
          title="Refresh"
        >
          <svg className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Refresh
        </button>
      </div>

      {/* Category filter bar */}
      <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 flex items-center gap-1.5 flex-wrap shrink-0">
        {CATEGORY_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setCategoryFilter(opt.value)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
              categoryFilter === opt.value
                ? "bg-brand-600 text-white"
                : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Event list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading && events.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">
            Loading events...
          </div>
        ) : error ? (
          <div className="px-4 py-3 text-red-600 dark:text-red-400 text-sm">{error}</div>
        ) : events.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-gray-400 dark:text-gray-500">
            <svg className="w-8 h-8 mb-2 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
            <span className="text-sm">No events{categoryFilter !== "all" ? ` in "${categoryFilter}" category` : ""}</span>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {events.map((event) => (
              <div
                key={event.id}
                className="px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors cursor-pointer"
                onClick={() => setExpandedId(expandedId === event.id ? null : event.id)}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${LEVEL_DOT_CLASSES[event.level]}`}
                    title={event.level}
                  />
                  <div className="min-w-0 flex-1">
                    {/* Top row: category badge + issue link + age */}
                    <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                      {event.category && (
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${CATEGORY_BADGE_CLASSES[event.category]}`}>
                          {event.category.replace(/_/g, " ")}
                        </span>
                      )}
                      {event.issueNumber !== null && (
                        <button
                          className="text-[11px] font-mono text-brand-600 dark:text-brand-400 hover:underline"
                          title={`Open issue #${event.issueNumber}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenIssue?.(event.issueNumber as number);
                          }}
                        >
                          #{event.issueNumber}
                        </button>
                      )}
                      <span
                        className="text-[10px] text-gray-400 dark:text-gray-500 font-mono ml-auto shrink-0"
                        title={formatTimestamp(event.timestamp)}
                      >
                        {formatAge(event.timestamp)}
                      </span>
                    </div>

                    {/* Summary */}
                    <div className={`text-[12px] leading-snug ${event.level === "error" ? "text-red-700 dark:text-red-300" : "text-gray-700 dark:text-gray-300"}`}>
                      {event.summary}
                    </div>

                    {/* Expanded details */}
                    {expandedId === event.id && event.details && (
                      <div className="mt-1.5 px-2 py-1.5 rounded-md bg-gray-100 dark:bg-gray-800 text-[11px] font-mono text-gray-600 dark:text-gray-400 leading-relaxed whitespace-pre-wrap break-all">
                        {event.details}
                      </div>
                    )}

                    {/* Event type + timestamp row */}
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="text-[10px] text-gray-400 dark:text-gray-500 uppercase">
                        {event.type.replace(/_/g, " ")}
                      </span>
                      <span className="text-[10px] text-gray-300 dark:text-gray-600">·</span>
                      <span className="text-[10px] text-gray-400 dark:text-gray-500 font-mono">
                        {formatTimestamp(event.timestamp)}
                      </span>
                      {event.details && (
                        <>
                          <span className="text-[10px] text-gray-300 dark:text-gray-600">·</span>
                          <span className="text-[10px] text-gray-400 dark:text-gray-500">
                            {expandedId === event.id ? "collapse" : "details"}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Load more */}
        {events.length === limit && (
          <div className="px-4 py-3 border-t border-gray-100 dark:border-gray-800">
            <button
              onClick={() => setLimit((l) => l + 50)}
              className="w-full py-1.5 text-[12px] text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            >
              Load more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
