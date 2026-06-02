import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { MonitorActionReplayDrawer, type ReplayTarget } from "./MonitorActionReplayDrawer.js";
import { MonitorCycleTimeline } from "./MonitorCycleTimeline.js";

/** Shape returned by GET /api/projects/:id/board-health-events */
interface BoardHealthEvent {
  id: string;
  timestamp: string;
  level: "info" | "error";
  type: "cycle_start" | "cycle_end" | "observation" | "action" | "error";
  summary: string;
  details: string | null;
}

type EventTypeFilter = "all" | "action" | "error" | "observation" | "cycle_start" | "cycle_end";
type SortKey = "timestamp" | "type";
type SortDir = "asc" | "desc";

type PanelView = "timeline" | "events";

interface MonitorCycleHistoryPanelProps {
  projectId: string | null;
}

/** User-facing filter categories that map to server event types. */
const FILTER_OPTIONS: { value: EventTypeFilter; label: string; types?: string[] }[] = [
  { value: "all", label: "All events" },
  { value: "action", label: "Actions", types: ["action"] },
  { value: "error", label: "Errors", types: ["error"] },
  { value: "observation", label: "Observations", types: ["observation"] },
  { value: "cycle_start", label: "Cycle starts", types: ["cycle_start"] },
  { value: "cycle_end", label: "Cycle ends", types: ["cycle_end"] },
];

const TYPE_BADGE_CLASSES: Record<string, string> = {
  cycle_start: "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300",
  cycle_end: "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300",
  observation: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300",
  action: "bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300",
  error: "bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300",
};

const TYPE_LABELS: Record<string, string> = {
  cycle_start: "Cycle Start",
  cycle_end: "Cycle End",
  observation: "Observation",
  action: "Action",
  error: "Error",
};

export function MonitorCycleHistoryPanel({ projectId }: MonitorCycleHistoryPanelProps) {
  const [view, setView] = useState<PanelView>("timeline");
  const [events, setEvents] = useState<BoardHealthEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("timestamp");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [typeFilter, setTypeFilter] = useState<EventTypeFilter>("all");
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);
  const [limit, setLimit] = useState(50);
  const [replayTarget, setReplayTarget] = useState<ReplayTarget | null>(null);

  const fetchEvents = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const filterDef = FILTER_OPTIONS.find((f) => f.value === typeFilter);
      const params = new URLSearchParams({ limit: String(limit) });
      if (filterDef?.types?.length) {
        params.set("eventType", filterDef.types.join(","));
      }
      const data = await apiFetch<BoardHealthEvent[]>(
        `/api/projects/${projectId}/board-health-events?${params.toString()}`,
      );
      setEvents(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load monitor history");
    } finally {
      setLoading(false);
    }
  }, [projectId, typeFilter, limit]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const filtered = useMemo(() => {
    return [...events].sort((a, b) => {
      const mult = sortDir === "asc" ? 1 : -1;
      if (sortKey === "timestamp") {
        return mult * (new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      }
      return mult * a.type.localeCompare(b.type);
    });
  }, [events, sortKey, sortDir]);

  /** Extract #N issue references from summary text. */
  function extractIssueNumbers(text: string): string[] {
    const matches = text.match(/#(\d+)/g);
    return matches ? [...new Set(matches)] : [];
  }

  function formatTimestamp(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  function formatAge(iso: string): string {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  const SortHeader = ({ k, label }: { k: SortKey; label: string }) => (
    <th
      className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 select-none whitespace-nowrap"
      onClick={() => handleSort(k)}
    >
      {label}
      {sortKey === k && <span className="ml-1">{sortDir === "desc" ? "↓" : "↑"}</span>}
    </th>
  );

  if (view === "timeline") {
    return <MonitorCycleTimeline projectId={projectId} onSwitchToEvents={() => setView("events")} />;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-white dark:bg-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="flex items-center gap-2">
          <svg
            className="w-4 h-4 text-indigo-500"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Monitor Cycle History
          </h2>
          {events.length > 0 && (
            <span className="text-xs bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 px-2 py-0.5 rounded-full font-medium">
              {filtered.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center gap-1">
            <button
              className="px-2 py-1 text-xs rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
              onClick={() => setView("timeline")}
            >
              Timeline
            </button>
            <button
              className="px-2 py-1 text-xs rounded bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 font-medium"
              disabled
            >
              Events
            </button>
          </div>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as EventTypeFilter)}
            className="text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300"
          >
            {FILTER_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300"
          >
            <option value={20}>Last 20</option>
            <option value={50}>Last 50</option>
          </select>
          <button
            onClick={fetchEvents}
            disabled={loading}
            className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 disabled:opacity-40"
            title="Refresh"
          >
            <svg
              className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {error && (
          <div className="m-4 p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-gray-400 dark:text-gray-600 text-sm gap-2">
            <svg
              className="w-8 h-8"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <p>No monitor cycle events</p>
            <p className="text-xs text-center max-w-xs">
              Events appear here when the board monitor completes cycles. Enable auto-monitor
              in the Monitor sidebar to start recording.
            </p>
          </div>
        )}

        {filtered.length > 0 && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
              <tr>
                <SortHeader k="timestamp" label="Time" />
                <SortHeader k="type" label="Category" />
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                  Summary
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                  Issues
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                  Age
                </th>
                <th className="px-3 py-2 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {filtered.map((event) => {
                const issueRefs = extractIssueNumbers(event.summary);
                return (
                  <>
                    <tr
                      key={event.id}
                      className={`hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer group ${
                        event.level === "error"
                          ? "bg-red-50/30 dark:bg-red-950/20"
                          : ""
                      }`}
                      onClick={() =>
                        setExpandedEvent(expandedEvent === event.id ? null : event.id)
                      }
                    >
                      <td className="px-3 py-2 text-gray-600 dark:text-gray-400 whitespace-nowrap font-mono">
                        {formatTimestamp(event.timestamp)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                            TYPE_BADGE_CLASSES[event.type] ?? TYPE_BADGE_CLASSES.observation
                          }`}
                        >
                          {TYPE_LABELS[event.type] ?? event.type}
                        </span>
                      </td>
                      <td className="px-3 py-2 max-w-md">
                        <span
                          className="text-gray-800 dark:text-gray-200 line-clamp-2"
                          title={event.summary}
                        >
                          {event.summary}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {issueRefs.length > 0 ? (
                          <span className="flex gap-1">
                            {issueRefs.map((ref) => (
                              <span
                                key={ref}
                                className="font-mono text-[11px] px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
                              >
                                {ref}
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="text-gray-300 dark:text-gray-700">&mdash;</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap text-[11px] font-mono">
                        {formatAge(event.timestamp)}
                      </td>
                      <td className="px-3 py-2 w-8">
                        {projectId && (
                          <button
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                            title="Open replay drawer"
                            onClick={(e) => {
                              e.stopPropagation();
                              setReplayTarget({ kind: "event", event, projectId });
                            }}
                          >
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
                            </svg>
                          </button>
                        )}
                      </td>
                    </tr>
                    {expandedEvent === event.id && (
                      <tr
                        key={`${event.id}-expanded`}
                        className="bg-gray-50 dark:bg-gray-900"
                      >
                        <td colSpan={6} className="px-4 py-3">
                          <div className="space-y-2">
                            <div className="grid grid-cols-2 gap-4 text-xs">
                              <div>
                                <span className="text-gray-500 dark:text-gray-400">
                                  Full summary
                                </span>
                                <p className="text-gray-800 dark:text-gray-200 break-words mt-0.5">
                                  {event.summary}
                                </p>
                              </div>
                              <div>
                                <span className="text-gray-500 dark:text-gray-400">
                                  Event type
                                </span>
                                <p className="text-gray-800 dark:text-gray-200 mt-0.5">
                                  <span
                                    className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                                      TYPE_BADGE_CLASSES[event.type] ??
                                      TYPE_BADGE_CLASSES.observation
                                    }`}
                                  >
                                    {TYPE_LABELS[event.type] ?? event.type}
                                  </span>
                                </p>
                              </div>
                            </div>
                            {event.details && (
                              <div>
                                <span className="text-xs text-gray-500 dark:text-gray-400">
                                  Details
                                </span>
                                <pre className="mt-0.5 p-2 bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-700 rounded text-xs text-gray-700 dark:text-gray-300 overflow-auto max-h-32 whitespace-pre-wrap">
                                  {event.details}
                                </pre>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-800 shrink-0 flex items-center justify-between">
        <p className="text-xs text-gray-400 dark:text-gray-600">
          {filtered.length} event{filtered.length !== 1 ? "s" : ""}
          {typeFilter !== "all" ? ` · filtered by ${typeFilter.replace(/_/g, " ")}` : ""}
        </p>
        <p className="text-xs text-gray-400 dark:text-gray-600">
          API:{" "}
          <code className="font-mono">/api/projects/:id/board-health-events</code>
        </p>
      </div>

      {replayTarget && (
        <MonitorActionReplayDrawer
          target={replayTarget}
          onClose={() => setReplayTarget(null)}
        />
      )}
    </div>
  );
}
