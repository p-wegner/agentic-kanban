import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

// ── Timeline + cost (#292, #294) ─────────────────────────────────────
//
// Split out of PluginLoopExtras (#465) so that file stays under the god-module ceiling — the
// loop's audit timeline (event collapsing, category filters, cost rollup) is a cohesive,
// independently testable unit.

type LoopEventsResponse = {
  events: Array<{ id: string; type: string; payload: Record<string, unknown> | null; createdAt: string }>;
  cost: { totalUsd: number; byUnit: Array<{ unitId: string; costUsd: number; sessions: number }> };
};

function eventSummary(event: LoopEventsResponse["events"][number]): string {
  const p = event.payload ?? {};
  switch (event.type) {
    case "advance": {
      const created = Array.isArray(p.created) ? p.created.length : 0;
      const note = typeof p.note === "string" && p.note ? ` — ${p.note}` : "";
      return created > 0 ? `Advanced: ${created} ticket(s) created${note}` : `Advanced: nothing planned${note}`;
    }
    case "gate-reached":
      return `Reached gate: ${typeof p.question === "string" ? p.question : String(p.gateId ?? "")}`;
    case "gate-resolved": {
      const input = typeof p.input === "string" && p.input ? ` — "${p.input.slice(0, 120)}"` : "";
      return `Decision: ${String(p.actionLabel ?? p.actionId ?? "?")}${input}`;
    }
    case "gate-recommendation":
      return `Butler pre-read: ${typeof p.actionId === "string" ? p.actionId : "?"}`
        + (typeof p.reason === "string" && p.reason ? ` — ${p.reason}` : "");
    // Why a gate got no pre-read. Without this the absence of a chip was indistinguishable
    // from the feature being off, the butler being cold, or the model replying garbage.
    case "gate-recommendation-skipped":
      return `No butler pre-read (${typeof p.reason === "string" ? p.reason : "unknown"})`
        + (typeof p.detail === "string" && p.detail ? ` — ${p.detail}` : "");
    case "paused": return "Paused by a human";
    case "resumed": return "Resumed";
    case "converged": return "Converged — nothing left to do";
    default: return event.type;
  }
}

export type LoopEvent = LoopEventsResponse["events"][number];

/**
 * 200, not 50 (#448): a run of identical heartbeats now costs ONE row, so a bigger window buys
 * real history instead of more of the same line. Not higher — the live loop's full 360-event
 * history is a 1 MB payload refetched on every advance and gate decision, and each event
 * carries the whole gate note. The residual gap is legacy data (rows written before the server
 * started restamping no-op advances) and is called out in the list when the window saturates.
 */
const TIMELINE_EVENT_LIMIT = 200;

/** One timeline row, which may stand for a whole run of identical events (#448). */
export type TimelineRow = {
  key: string;
  type: string;
  summary: string;
  /** The newest occurrence — what "3m ago" refers to. */
  createdAt: string;
  /** The oldest occurrence of the collapsed run; equal to `createdAt` for a single event. */
  firstSeenAt: string;
  count: number;
};

/**
 * Collapse consecutive identical events into one row (#448 proposal 1).
 *
 * ── The problem, MEASURED ──
 *
 * The monitor re-plans a gated loop every ~4 minutes and each no-op advance was persisted as
 * its own event carrying the full gate note. With `limit=50`, a gate that had been waiting 13h
 * meant the timeline held NOTHING BUT heartbeat: `gate-reached`, `gate-resolved`, `converged`,
 * the butler pre-reads and every step completion were all pushed out of the window. #412 made
 * this history discoverable and auto-opened it at a gate — exactly when it was least usable.
 *
 * The server side of that ticket (d9cf0d1009) stopped appending: an unchanged no-op advance now
 * restamps the previous row, incrementing `payload.repeatCount` and pinning
 * `payload.firstSeenAt` to the start of the run. `repeatCount` absent or 1 means it happened
 * exactly once — true of every row written before that change, which is why `?? 1` is all the
 * back-compat needed.
 *
 * This function handles BOTH: it honours a server-collapsed row's `repeatCount`/`firstSeenAt`,
 * and it still folds together the runs of separate rows that older data (and any event type the
 * server does not collapse) contains.
 */
export function collapseTimelineEvents(events: LoopEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const event of events) {
    const summary = eventSummary(event);
    const payload = event.payload ?? {};
    const repeat = typeof payload.repeatCount === "number" && payload.repeatCount > 0 ? payload.repeatCount : 1;
    const firstSeen = typeof payload.firstSeenAt === "string" && payload.firstSeenAt
      ? payload.firstSeenAt
      : event.createdAt;
    const previous = rows[rows.length - 1];
    if (previous && previous.type === event.type && previous.summary === summary) {
      // Events arrive newest-first, so a later member of the run is always the older one.
      previous.count += repeat;
      previous.firstSeenAt = firstSeen;
      continue;
    }
    rows.push({
      key: event.id,
      type: event.type,
      summary,
      createdAt: event.createdAt,
      firstSeenAt: firstSeen,
      count: repeat,
    });
  }
  return rows;
}

export type TimelineCategory = "advances" | "gates" | "decisions" | "other";

/** Which filter chip an event belongs under (#448 proposal 3). */
export function timelineCategory(type: string): TimelineCategory {
  switch (type) {
    case "advance": return "advances";
    case "gate-reached":
    case "gate-recommendation":
    case "gate-recommendation-skipped": return "gates";
    case "gate-resolved":
    case "paused":
    case "resumed":
    case "converged": return "decisions";
    default: return "other";
  }
}

const CATEGORY_LABEL: Record<TimelineCategory, string> = {
  advances: "Advances",
  gates: "Gates",
  decisions: "Decisions",
  other: "Other",
};

const EVENT_MARK: Record<string, string> = {
  "advance": "▸",
  "gate-reached": "✋",
  "gate-resolved": "✔",
  "gate-recommendation": "🤵",
  "gate-recommendation-skipped": "◌",
  "paused": "⏸",
  "resumed": "▶",
  "converged": "★",
};

/**
 * #412 — the loop's audit timeline was nearly undiscoverable: a COLLAPSED toggle at the
 * very bottom of the pane, labelled neither "timeline" nor "events" (a DOM text search for
 * `timeline|events` across the whole Plugins view returned zero hits), showing nothing at
 * all until clicked. Diagnosing "why is nothing happening" therefore sent operators to curl
 * the events API. Three changes, all cheap: name it, let the collapsed toggle advertise its
 * most recent event, and open it by default while a gate is waiting — the moment a human is
 * deciding is exactly when the recent history matters.
 */
export function LoopTimeline({ pluginId, loopName, projectId, refreshKey, hasGate = false }: {
  pluginId: string;
  loopName: string;
  projectId: string;
  /** Bump to refetch (e.g. after an advance or gate decision). */
  refreshKey: number;
  /** This loop is blocked on a human right now — open the history unasked. */
  hasGate?: boolean;
}) {
  const [open, setOpen] = useState(hasGate);
  const [data, setData] = useState<LoopEventsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<TimelineCategory | "all">("all");

  // Auto-open when a gate APPEARS (the surface usually loads after this mounts). Only on the
  // transition, so a human who deliberately collapsed it is not fought on the next poll.
  const sawGateRef = useRef(hasGate);
  useEffect(() => {
    if (hasGate && !sawGateRef.current) setOpen(true);
    sawGateRef.current = hasGate;
  }, [hasGate]);

  // Fetched whether or not it is open: the collapsed label shows the latest event, which is
  // the whole point of the change — and it makes expanding instant instead of a loading flash.
  useEffect(() => {
    let cancelled = false;
    apiFetch<LoopEventsResponse>(
      `/api/plugins/${pluginId}/loops/${encodeURIComponent(loopName)}/events?projectId=${projectId}&limit=${TIMELINE_EVENT_LIMIT}`,
    )
      .then((res) => { if (!cancelled) { setData(res); setError(null); } })
      .catch((err) => { if (!cancelled) setError(errorMessage(err)); });
    return () => { cancelled = true; };
  }, [pluginId, loopName, projectId, refreshKey]);

  const latest = data?.events[0];
  const rows = useMemo(() => collapseTimelineEvents(data?.events ?? []), [data]);
  const categories = useMemo(() => {
    const present: TimelineCategory[] = [];
    for (const row of rows) {
      const cat = timelineCategory(row.type);
      if (!present.includes(cat)) present.push(cat);
    }
    return present;
  }, [rows]);
  const visibleRows = category === "all" ? rows : rows.filter((r) => timelineCategory(r.type) === category);
  return (
    <div className="border-t border-gray-100 dark:border-gray-800 pt-3" data-testid="plugin-loop-timeline">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-full items-baseline gap-1.5 text-left text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
      >
        <span className="shrink-0">{open ? "▾" : "▸"} Timeline &amp; cost</span>
        {/* Collapsed, this used to show NOTHING — so the toggle advertised neither what it
            held nor that anything had happened. The newest event is the one line that makes
            "is this loop doing something?" answerable without a click. */}
        {!open && latest && (
          <span className="truncate text-gray-400 dark:text-gray-500" data-testid="plugin-loop-timeline-latest">
            · {EVENT_MARK[latest.type] ?? "·"} {eventSummary(latest)} — {formatRelativeTime(latest.createdAt)}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
          {!data && !error && <div className="text-xs text-gray-400">Loading…</div>}
          {data && (
            <>
              {(data.cost.totalUsd > 0 || data.cost.byUnit.length > 0) && (
                <div className="text-xs text-gray-600 dark:text-gray-300">
                  Total agent cost: <span className="font-medium">${data.cost.totalUsd.toFixed(2)}</span>
                  {data.cost.byUnit.length > 0 && (
                    <span className="text-gray-400 dark:text-gray-500">
                      {" "}({data.cost.byUnit.slice(0, 5).map((u) => `${u.unitId}: $${u.costUsd.toFixed(2)}`).join(" · ")})
                    </span>
                  )}
                </div>
              )}
              {/* Filter chips (#448 proposal 3). Only categories actually present are offered —
                  a chip that always filters to nothing is worse than no chip. */}
              {categories.length > 1 && (
                <div className="flex flex-wrap items-center gap-1" data-testid="plugin-loop-timeline-filters">
                  {(["all", ...categories] as const).map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setCategory(cat)}
                      aria-pressed={category === cat}
                      data-testid={`plugin-loop-timeline-filter-${cat}`}
                      className={`text-[10px] px-2 py-0.5 rounded border ${
                        category === cat
                          ? "border-brand-500 bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300"
                          : "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                      }`}
                    >
                      {cat === "all" ? "All" : CATEGORY_LABEL[cat]}
                    </button>
                  ))}
                </div>
              )}
              <ul className="space-y-1">
                {visibleRows.map((row) => (
                  <li
                    key={row.key}
                    className="text-[11px] text-gray-600 dark:text-gray-300 flex items-baseline gap-1.5"
                    data-testid="plugin-loop-timeline-row"
                    data-repeat-count={row.count}
                  >
                    <span className="text-gray-400 dark:text-gray-500 w-3 shrink-0" aria-hidden="true">{EVENT_MARK[row.type] ?? "·"}</span>
                    <span className="flex-1">
                      {row.summary}
                      {row.count > 1 && (
                        <span className="ml-1 text-gray-400 dark:text-gray-500" title={`Repeated ${row.count} times without changing`}>
                          ×{row.count}
                        </span>
                      )}
                    </span>
                    <span className="text-gray-400 dark:text-gray-500 shrink-0">
                      {row.count > 1 ? `last ${formatRelativeTime(row.createdAt)} · unchanged since ${formatRelativeTime(row.firstSeenAt)}` : formatRelativeTime(row.createdAt)}
                    </span>
                  </li>
                ))}
                {/* Say when the window itself is the limit. On a loop that gated BEFORE the
                    server started restamping no-op advances (d9cf0d1009) the backlog can be
                    hundreds of legacy heartbeat rows, and then even 200 events collapse to one
                    row with everything real still unfetched. Better to admit that than to let
                    the absence of `gate-reached` read as "it never happened". */}
                {data.events.length >= TIMELINE_EVENT_LIMIT && (
                  <li className="text-[10px] text-gray-400 dark:text-gray-500" data-testid="plugin-loop-timeline-truncated">
                    Showing the newest {TIMELINE_EVENT_LIMIT} events — older history exists and is
                    not fetched.
                  </li>
                )}
                {visibleRows.length === 0 && (
                  <li className="text-[11px] text-gray-400">
                    {rows.length === 0 ? "No history yet." : "Nothing in this category."}
                  </li>
                )}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
