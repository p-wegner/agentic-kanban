import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * One worker's event timeline (#774), from `GET /api/workers/:id/events`.
 *
 * Why this exists: the board kept no history of what a worker did, so a #699/#706-class
 * failure ("the worker vanished mid-run and the session hung") was reconstructed from the
 * server console — which a restart discards. The endpoint is capped per worker, so this
 * renders the whole retained timeline rather than paginating.
 *
 * Loaded ON EXPAND, not with the panel: a fleet of ten workers would otherwise mean ten
 * extra queries on every 15-second poll for a timeline nobody has opened.
 */
export interface WorkerEvent {
  id: string;
  workerId: string;
  type: string;
  sessionId: string | null;
  summary: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

const TYPE_COLORS: Record<string, string> = {
  registered: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  protocol_mismatch: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  ref_landed: "bg-accent-50 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300",
  ref_discarded: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
};

export function WorkerEventTimeline({ workerId }: { workerId: string }) {
  const [events, setEvents] = useState<WorkerEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch<{ events: WorkerEvent[] }>(`/api/workers/${workerId}/events?limit=100`)
      .then((r) => {
        setEvents(r.events);
        setLoading(false);
      })
      .catch((err) => {
        setError(errorMessage(err));
        setLoading(false);
      });
  }, [workerId]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return <div className="mt-2 text-xs text-red-600 dark:text-red-400">Timeline unavailable: {error}</div>;
  }
  if (loading && !events) {
    return <div className="mt-2 text-xs text-gray-400 dark:text-gray-500">Loading timeline…</div>;
  }
  if (events && events.length === 0) {
    return (
      <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        No events recorded for this worker yet. The board records registration, protocol
        mismatches and incoming-ref decisions; WebSocket connect/disconnect and per-session
        assign/exit are not recorded yet.
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400">
          Timeline ({events?.length ?? 0} event{events?.length === 1 ? "" : "s"})
        </div>
        <button
          onClick={load}
          disabled={loading}
          title="Reload timeline"
          className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-40"
        >
          ↻
        </button>
      </div>
      <ol className="space-y-1">
        {events?.map((e) => (
          <li key={e.id} className="flex items-start gap-2 text-xs">
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 ${
                TYPE_COLORS[e.type] ?? "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
              }`}
            >
              {e.type}
            </span>
            <span className="min-w-0 flex-1 text-gray-600 dark:text-gray-300">
              {e.summary}
              {e.sessionId && (
                <span className="ml-1 text-gray-400 dark:text-gray-500">· session {e.sessionId.slice(0, 8)}</span>
              )}
            </span>
            <span
              className="shrink-0 text-gray-400 dark:text-gray-500"
              title={e.createdAt}
            >
              {formatRelativeTime(e.createdAt)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
