import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { WorkerDropCause, WorkerDropDiagnosis, WorkerEvent } from "@agentic-kanban/shared/types";

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
 *
 * The row SHAPE is imported, not re-declared (#801): this component and the server service
 * each held their own copy of it, which is the two-hand-maintained-copies drift
 * `wire-dto-single-declaration.test.ts` exists to stop.
 */
export type { WorkerEvent };

const TYPE_COLORS: Record<string, string> = {
  registered: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  protocol_mismatch: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  ref_landed: "bg-accent-50 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300",
  ref_discarded: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
};

/**
 * #881 — every way a worker can stop being usable rendered as the same word, `offline`. The
 * board now derives WHICH way from the timeline, so the panel leads with the answer instead
 * of making an operator read 100 rows to reach it. Colour carries urgency, not decoration:
 * `process-gone` needs a human to go and restart something, the rest resolve or recur.
 */
const CAUSE_STYLES: Record<WorkerDropCause, { label: string; className: string }> = {
  "process-gone": {
    label: "Process gone",
    className: "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200",
  },
  "heartbeat-stall": {
    label: "Heartbeat stall",
    className:
      "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  },
  "silent-respawn": {
    label: "Restart loop",
    className:
      "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  },
  cycling: {
    label: "Periodic drops",
    className:
      "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  },
  flapping: {
    label: "Unstable link",
    className:
      "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  },
  healthy: {
    label: "No drops",
    className:
      "border-green-300 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200",
  },
  "insufficient-data": {
    label: "Not enough history",
    className: "border-gray-300 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300",
  },
};

function DropDiagnosis({ diagnosis }: { diagnosis: WorkerDropDiagnosis }) {
  const style = CAUSE_STYLES[diagnosis.cause] ?? CAUSE_STYLES["insufficient-data"];
  return (
    <div className={`mt-2 rounded border px-2 py-1.5 text-xs ${style.className}`}>
      <div className="flex items-center gap-1.5">
        <span className="font-medium">{style.label}</span>
        {/* A low-confidence verdict says so on its face — a guess presented as a finding is
            worse than no finding. */}
        {diagnosis.confidence === "low" && <span className="opacity-70">· low confidence</span>}
      </div>
      <div className="mt-0.5">{diagnosis.headline}</div>
      <div className="mt-0.5 opacity-80">{diagnosis.detail}</div>
    </div>
  );
}

export function WorkerEventTimeline({ workerId }: { workerId: string }) {
  const [events, setEvents] = useState<WorkerEvent[] | null>(null);
  const [diagnosis, setDiagnosis] = useState<WorkerDropDiagnosis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch<{ events: WorkerEvent[]; diagnosis?: WorkerDropDiagnosis }>(
      `/api/workers/${workerId}/events?limit=100`,
    )
      .then((r) => {
        setEvents(r.events);
        setDiagnosis(r.diagnosis ?? null);
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
        {/* This used to claim connect/disconnect and assign/exit were "not recorded yet",
            which #801 made false — and false in exactly the place an operator checks when
            those rows are the ones they are missing. */}
        No events recorded for this worker yet. Once it registers, the board records
        registration, connect/disconnect, status changes, per-session assign/exit,
        undelivered results and incoming-ref decisions.
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-1">
      {diagnosis && <DropDiagnosis diagnosis={diagnosis} />}
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
