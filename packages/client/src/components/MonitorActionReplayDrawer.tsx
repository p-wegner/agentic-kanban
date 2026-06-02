import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "../lib/api.js";
import type { MonitorAction } from "./MonitorPopover.js";

/** Full event detail shape returned by GET /api/projects/:id/board-health-events/:eventId */
interface BoardHealthEventDetail {
  id: string;
  cycleId: string;
  timestamp: string;
  level: "info" | "error";
  type: string;
  category: string | null;
  issueNumber: number | null;
  summary: string;
  details: unknown;
}

/** Discriminated payload shapes stored in MonitorAction details */
interface ActionDetails {
  endpoint?: string;
  httpStatus?: number;
  responseSummary?: string;
  verificationResult?: "ok" | "failed" | "skipped";
  tool?: string;
  toolsUsed?: string[];
  strategySource?: string;
  isError?: boolean;
  totals?: Record<string, number>;
}

const ACTION_LABELS: Record<MonitorAction["action"] | "generate_tickets", { label: string; colorClass: string; icon: string }> = {
  relaunch:         { label: "Relaunched agent",   colorClass: "text-blue-600 dark:text-blue-400",   icon: "↺" },
  merge:            { label: "Triggered merge",    colorClass: "text-brand-600 dark:text-brand-400", icon: "⇒" },
  nudge:            { label: "Nudged agent",       colorClass: "text-amber-600 dark:text-amber-400", icon: "⚡" },
  mark_idle:        { label: "Marked idle",        colorClass: "text-gray-500 dark:text-gray-400",   icon: "⏸" },
  mark_dead:        { label: "Marked dead",        colorClass: "text-red-500 dark:text-red-400",     icon: "✕" },
  auto_start:       { label: "Auto-started issue", colorClass: "text-green-600 dark:text-green-400", icon: "▶" },
  generate_tickets: { label: "Generated tickets",  colorClass: "text-violet-600 dark:text-violet-400", icon: "✦" },
};

function VerificationBadge({ result }: { result?: string }) {
  if (!result) return null;
  const classes =
    result === "ok"
      ? "bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300"
      : result === "failed"
      ? "bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300"
      : "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400";
  const label = result === "ok" ? "verified ok" : result === "failed" ? "verification failed" : "skipped";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${classes}`}>{label}</span>
  );
}

function HttpStatusBadge({ status }: { status?: number }) {
  if (!status) return null;
  const ok = status >= 200 && status < 300;
  return (
    <span
      className={`font-mono text-[11px] px-1.5 py-0.5 rounded ${
        ok
          ? "bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300"
          : "bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300"
      }`}
    >
      HTTP {status}
    </span>
  );
}

/** Render a RecentAction (from in-memory buffer) as a replay drawer.
 *  This variant doesn't need a projectId lookup — all data comes from the action itself. */
function ActionView({ action, issueNumber, onOpenWorkspace, onClose }: {
  action: MonitorAction;
  issueNumber?: number | null;
  onOpenWorkspace?: (workspaceId: string, issueId: string) => void;
  onClose: () => void;
}) {
  const meta = ACTION_LABELS[action.action] ?? { label: action.action, colorClass: "text-gray-600", icon: "•" };
  const timestamp = new Date(action.at).toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });

  return (
    <div className="space-y-4">
      {/* Action type header */}
      <div className="flex items-center gap-3">
        <span className="text-2xl leading-none">{meta.icon}</span>
        <div>
          <div className={`font-semibold text-sm ${meta.colorClass}`}>{meta.label}</div>
          <div className="text-xs text-gray-400 dark:text-gray-500 font-mono">{timestamp}</div>
        </div>
      </div>

      {/* Target */}
      <section>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Target</div>
        <div className="rounded-md bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs space-y-1">
          {issueNumber != null && (
            <div className="flex items-center gap-2">
              <span className="text-gray-500 dark:text-gray-400 w-20 shrink-0">Issue</span>
              <span className="font-mono text-gray-800 dark:text-gray-200">#{issueNumber}</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-gray-500 dark:text-gray-400 w-20 shrink-0">Workspace</span>
            <button
              className="font-mono text-brand-600 dark:text-brand-400 hover:underline truncate max-w-[200px]"
              title={action.workspaceId}
              onClick={() => { onOpenWorkspace?.(action.workspaceId, action.issueId); onClose(); }}
            >
              {action.workspaceId.slice(0, 8)}…
            </button>
          </div>
        </div>
      </section>

      {/* Request */}
      {action.endpoint && (
        <section>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Request</div>
          <div className="rounded-md bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-gray-500 dark:text-gray-400 w-20 shrink-0">Endpoint</span>
              <span className="font-mono text-gray-800 dark:text-gray-200 break-all">{action.endpoint}</span>
            </div>
          </div>
        </section>
      )}

      {/* Response */}
      {(action.httpStatus != null || action.responseSummary) && (
        <section>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Response</div>
          <div className="rounded-md bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs space-y-1.5">
            {action.httpStatus != null && (
              <div className="flex items-center gap-2">
                <span className="text-gray-500 dark:text-gray-400 w-20 shrink-0">Status</span>
                <HttpStatusBadge status={action.httpStatus} />
              </div>
            )}
            {action.responseSummary && (
              <div className="flex items-start gap-2">
                <span className="text-gray-500 dark:text-gray-400 w-20 shrink-0 mt-0.5">Body</span>
                <span className="text-gray-700 dark:text-gray-300 break-words">{action.responseSummary}</span>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Verification */}
      {action.verificationResult && (
        <section>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Verification</div>
          <div className="flex items-center gap-2">
            <VerificationBadge result={action.verificationResult} />
          </div>
        </section>
      )}
    </div>
  );
}

/** Render a BoardHealthEvent (from DB) as a replay drawer. Fetches full details from server. */
function EventView({ event, projectId, onClose }: {
  event: { id: string; type: string; category: string | null; issueNumber: number | null; summary: string; timestamp: string };
  projectId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<BoardHealthEventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    apiFetch<BoardHealthEventDetail>(`/api/projects/${projectId}/board-health-events/${event.id}`)
      .then(setDetail)
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [event.id, projectId]);

  const timestamp = new Date(event.timestamp).toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });

  const actionDetails = (detail?.details && typeof detail.details === "object" && !Array.isArray(detail.details))
    ? (detail.details as ActionDetails)
    : null;

  return (
    <div className="space-y-4">
      {/* Event header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${
            event.type === "error" ? "bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300"
            : event.type === "action" ? "bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300"
            : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
          }`}>
            {event.type.replace(/_/g, " ")}
          </span>
          {event.category && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300">
              {event.category}
            </span>
          )}
        </div>
        <div className="text-xs text-gray-400 dark:text-gray-500 font-mono">{timestamp}</div>
      </div>

      {/* Summary */}
      <section>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Summary</div>
        <p className="text-sm text-gray-800 dark:text-gray-200 leading-relaxed">{event.summary}</p>
        {event.issueNumber != null && (
          <div className="mt-1.5 inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
            <span>Issue</span>
            <span className="font-mono text-brand-600 dark:text-brand-400">#{event.issueNumber}</span>
          </div>
        )}
      </section>

      {loading && (
        <div className="text-xs text-gray-400 dark:text-gray-500">Loading details...</div>
      )}
      {err && (
        <div className="text-xs text-red-600 dark:text-red-400">{err}</div>
      )}

      {/* Action-specific fields from details */}
      {actionDetails && (
        <>
          {actionDetails.endpoint && (
            <section>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Request</div>
              <div className="rounded-md bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs">
                <span className="text-gray-500 dark:text-gray-400">Endpoint </span>
                <span className="font-mono text-gray-800 dark:text-gray-200 break-all">{actionDetails.endpoint}</span>
              </div>
            </section>
          )}

          {(actionDetails.httpStatus != null || actionDetails.responseSummary) && (
            <section>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Response</div>
              <div className="rounded-md bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs space-y-1.5">
                {actionDetails.httpStatus != null && (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 dark:text-gray-400 w-16 shrink-0">Status</span>
                    <HttpStatusBadge status={actionDetails.httpStatus} />
                  </div>
                )}
                {actionDetails.responseSummary && (
                  <div className="flex items-start gap-2">
                    <span className="text-gray-500 dark:text-gray-400 w-16 shrink-0 mt-0.5">Body</span>
                    <span className="text-gray-700 dark:text-gray-300 break-words max-h-32 overflow-y-auto">
                      {actionDetails.responseSummary}
                    </span>
                  </div>
                )}
              </div>
            </section>
          )}

          {actionDetails.verificationResult && (
            <section>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Verification</div>
              <VerificationBadge result={actionDetails.verificationResult} />
            </section>
          )}

          {actionDetails.toolsUsed && actionDetails.toolsUsed.length > 0 && (
            <section>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Tools used</div>
              <div className="flex flex-wrap gap-1">
                {actionDetails.toolsUsed.map((t, i) => (
                  <span key={i} className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">{t}</span>
                ))}
              </div>
            </section>
          )}

          {actionDetails.tool && (
            <section>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Tool invoked</div>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">{actionDetails.tool}</span>
            </section>
          )}

          {actionDetails.totals && (
            <section>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Board snapshot</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(actionDetails.totals).map(([k, v]) => (
                  <div key={k} className="rounded-md bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs">
                    <div className="text-[10px] text-gray-400 dark:text-gray-500">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</div>
                    <div className="font-semibold text-gray-700 dark:text-gray-300">{v}</div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Raw details fallback */}
      {detail?.details && !actionDetails && (
        <section>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Details</div>
          <pre className="rounded-md bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs text-gray-700 dark:text-gray-300 overflow-auto max-h-48 whitespace-pre-wrap">
            {typeof detail.details === "string" ? detail.details : JSON.stringify(detail.details, null, 2)}
          </pre>
        </section>
      )}

      {/* Cycle link */}
      {detail?.cycleId && (
        <div className="text-[10px] text-gray-400 dark:text-gray-500 font-mono">Cycle {detail.cycleId.slice(0, 8)}…</div>
      )}
    </div>
  );
}

export type ReplayTarget =
  | { kind: "action"; action: MonitorAction; issueNumber?: number | null }
  | { kind: "event"; event: { id: string; type: string; category: string | null; issueNumber: number | null; summary: string; timestamp: string }; projectId: string };

interface MonitorActionReplayDrawerProps {
  target: ReplayTarget;
  onClose: () => void;
  onOpenWorkspace?: (workspaceId: string, issueId: string) => void;
}

export function MonitorActionReplayDrawer({ target, onClose, onOpenWorkspace }: MonitorActionReplayDrawerProps) {
  useEffect(() => {
    function handler(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const title = target.kind === "action"
    ? (ACTION_LABELS[target.action.action]?.label ?? target.action.action)
    : "Event detail";

  return createPortal(
    <>
      <div className="fixed inset-0 z-40 bg-black/20 dark:bg-black/40" onClick={onClose} />
      <div
        className="fixed z-50 right-0 top-0 bottom-0 w-96 bg-white dark:bg-gray-950 border-l border-gray-200 dark:border-gray-700 shadow-2xl flex flex-col animate-slide-in-right"
        role="dialog"
        aria-label="Monitor action replay"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-indigo-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
            </svg>
            <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">Action replay</span>
            <span className="text-xs text-gray-400 dark:text-gray-500 truncate max-w-[160px]">{title}</span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title="Close"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {target.kind === "action" ? (
            <ActionView
              action={target.action}
              issueNumber={target.issueNumber}
              onOpenWorkspace={onOpenWorkspace}
              onClose={onClose}
            />
          ) : (
            <EventView
              event={target.event}
              projectId={target.projectId}
              onClose={onClose}
            />
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
