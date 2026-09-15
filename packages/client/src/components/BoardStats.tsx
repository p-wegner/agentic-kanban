import { useEffect, useRef, useState } from "react";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import {
  AGENT_KIND_LABEL,
  PULSE_TERMS,
  computeBoardStats,
  describeAgentActivity,
  formatAgentsRunning,
  formatTicketFlow,
  type AgentActivity,
  type AgentKind,
} from "../lib/boardStats.js";
import { useBoardFilterStore } from "../stores/boardFilterStore.js";
import { useDismissable } from "../hooks/useDismissable.js";
import { Icon } from "./Icon.js";

interface BoardStatsProps {
  activeColumns: StatusWithIssues[];
  archiveColumns: StatusWithIssues[];
  projectId?: string;
}

const STATUS_CONFIG: Record<string, { bar: string; dot: string; text: string; bg: string }> = {
  "Todo":        { bar: "bg-slate-400",   dot: "bg-slate-300",   text: "text-slate-600",   bg: "bg-slate-50" },
  "In Progress": { bar: "bg-amber-400",   dot: "bg-amber-300",   text: "text-amber-700",   bg: "bg-amber-50" },
  "In Review":   { bar: "bg-accent-500",  dot: "bg-accent-300",  text: "text-accent-700",  bg: "bg-accent-50" },
  "AI Reviewed": { bar: "bg-accent-500",  dot: "bg-accent-300",  text: "text-accent-700",  bg: "bg-accent-50" },
  "Done":        { bar: "bg-emerald-400", dot: "bg-emerald-300", text: "text-emerald-700", bg: "bg-emerald-50" },
  "Cancelled":   { bar: "bg-gray-400",    dot: "bg-gray-300",    text: "text-gray-500",    bg: "bg-gray-50" },
};

const DEFAULT_CONFIG = { bar: "bg-gray-400", dot: "bg-gray-300", text: "text-gray-600", bg: "bg-gray-50" };

// How long a fetched /stats result stays fresh — toggling the popover within
// this window does not re-hit the endpoint.
const STATS_CACHE_TTL_MS = 60_000;

function getConfig(name: string) {
  return STATUS_CONFIG[name] ?? DEFAULT_CONFIG;
}

export function BoardStats({
  activeColumns,
  archiveColumns,
  projectId,
}: BoardStatsProps) {
  // Filter slice (#958): subscribe to the store instead of a threaded prop.
  const isFiltered = useBoardFilterStore((s) => !!s.searchQuery);
  const {
    allColumns,
    total,
    doneCount,
    cancelledCount,
    nonCancelledTotal,
    completionPct,
    ticketFlow,
    agents,
  } = computeBoardStats(activeColumns, archiveColumns);

  const [commitCount, setCommitCount] = useState<number | null>(null);
  const [commitBranch, setCommitBranch] = useState<string | null>(null);
  // Tracks the last successful-or-in-flight /stats fetch (per project, with a
  // timestamp) so the popover-open effect below can dedupe StrictMode double
  // runs and rapid open/close toggles without refetching.
  const statsFetchRef = useRef<{ projectId: string; at: number } | null>(null);

  useEffect(() => {
    // Project switched: drop the previous project's stats so a stale commit
    // count never shows in the popover.
    setCommitCount(null);
    setCommitBranch(null);
    statsFetchRef.current = null;
  }, [projectId]);

  const [prevTotal, setPrevTotal] = useState(total);
  const [popKey, setPopKey] = useState(0);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (prevTotal !== total) {
      setPrevTotal(total);
      setPopKey((k) => k + 1);
    }
  }, [total, prevTotal]);

  const circumference = 2 * Math.PI * 14;
  const dashOffset = circumference * (1 - completionPct / 100);

  // The board summary used to span two rows (a pills row + a full-width segmented
  // bar with a per-status legend). Once Done dominates, the % / done count / all-green
  // bar / legend all encode the same "almost everything is done" fact — and the legend
  // duplicates the column-tab counts right below it. We now show a single compact
  // "pulse" line (live, changing signal: open work, active agents, blocked) and tuck
  // the static inventory (done, %, commits, profiles, full breakdown bar) behind a
  // click on the completion ring. (#small-screen header overhaul)
  const [showBreakdown, setShowBreakdown] = useState(false);
  const breakdownRef = useRef<HTMLDivElement>(null);

  // /api/projects/:id/stats runs expensive synchronous git + file-tree scans
  // server-side (205ms warm, multi-second cold) and its data (commit count /
  // branch) is ONLY rendered inside this popover — fetch it lazily on first
  // open instead of on every board mount, with a short per-project cache.
  useEffect(() => {
    if (!showBreakdown || !projectId) return;
    const last = statsFetchRef.current;
    if (last && last.projectId === projectId && Date.now() - last.at < STATS_CACHE_TTL_MS) return;
    const pid = projectId;
    statsFetchRef.current = { projectId: pid, at: Date.now() };
    apiFetch<{ commitCount: number; detectedBranch: string | null }>(`/api/projects/${pid}/stats`)
      .then((s) => {
        // Ignore responses that arrive after a project switch reset the ref.
        if (statsFetchRef.current?.projectId !== pid) return;
        setCommitCount(s.commitCount);
        setCommitBranch(s.detectedBranch);
      })
      .catch(() => {
        if (statsFetchRef.current?.projectId === pid) statsFetchRef.current = null;
      });
  }, [showBreakdown, projectId]);

  useDismissable(breakdownRef, showBreakdown, () => setShowBreakdown(false));

  return (
    <div data-testid="board-stats-bar" className="flex items-center gap-2 select-none flex-wrap">
      {/* Pulse: completion ring + headline count. The ring IS the completion indicator —
          click it for the full done/cancelled/commits/profiles breakdown + bar. */}
      <div className="relative" ref={breakdownRef}>
        <button
          type="button"
          onClick={() => setShowBreakdown((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={showBreakdown}
          data-testid="board-stats-tickets"
          title={`${formatTicketFlow(ticketFlow)}${total > 0 ? `\n${doneCount} of ${nonCancelledTotal} done (${completionPct}%)` : ""}\n${PULSE_TERMS.tickets} Click for the full breakdown.`}
          className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
        >
          {total > 0 && (
            <svg width="20" height="20" viewBox="0 0 32 32" className="shrink-0 -rotate-90">
              <circle cx="16" cy="16" r="14" fill="none" stroke="#e5e7eb" strokeWidth="4" />
              <circle
                cx="16" cy="16" r="14"
                fill="none"
                stroke="#34d399"
                strokeWidth="4"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                strokeLinecap="round"
                style={{ transition: "stroke-dashoffset 0.5s ease" }}
              />
            </svg>
          )}
          {isFiltered ? (
            <>
              <span
                key={popKey}
                className={`inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded-full text-[10px] font-bold text-white bg-brand-500 ${popKey > 0 ? "count-pop" : ""}`}
              >
                {total}
              </span>
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">filtered</span>
            </>
          ) : (
            // #1162: the per-column flow, not a bare "N open", which read as one more agent count next
            // to "active" and the Autopilot's "running". Done count + % live in the popover.
            <span key={popKey} className={`flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400 ${popKey > 0 ? "count-pop" : ""}`}>
              {ticketFlow.length === 0 ? (
                <span className="font-medium">no open tickets</span>
              ) : ticketFlow.map((c, i) => (
                <span key={c.id} className="whitespace-nowrap" data-testid={`board-stats-flow-${c.name}`}>
                  {i > 0 && <span className="text-gray-400 dark:text-gray-500 mr-1">·</span>}
                  <span className="font-bold text-gray-800 dark:text-gray-100">{c.count}</span> {c.label}
                </span>
              ))}
            </span>
          )}
          <Icon className={`w-2.5 h-2.5 text-gray-400 transition-transform ${showBreakdown ? "rotate-180" : ""}`} d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </button>

        {showBreakdown && (
          <div
            role="dialog"
            className="absolute top-full left-0 mt-1 z-30 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 shadow-lg flex flex-col gap-3"
          >
            {total > 0 && (
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-emerald-600">{completionPct}% complete</span>
                <span className="text-gray-500 dark:text-gray-400">
                  {doneCount} done{cancelledCount > 0 ? ` · ${cancelledCount} cancelled` : ""}
                </span>
              </div>
            )}
            {/* Segmented progress bar */}
            {total > 0 && (
              <div className="flex h-3 rounded-full overflow-hidden gap-px bg-gray-100 dark:bg-gray-800 shadow-inner">
                {allColumns.map((col) => {
                  if (col.count === 0) return null;
                  const pct = (col.count / total) * 100;
                  const cfg = getConfig(col.name);
                  return (
                    <div
                      key={col.id}
                      className={`${cfg.bar} transition-all duration-300`}
                      style={{ width: `${pct}%` }}
                      title={`${col.name}: ${col.count} (${Math.round(pct)}%)`}
                    />
                  );
                })}
              </div>
            )}
            {/* Per-status legend */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {allColumns.map((col) => {
                const cfg = getConfig(col.name);
                if (col.count === 0) return null;
                return (
                  <div
                    key={col.id}
                    // #659 — a STABLE hook. The e2e spec used to select this row by its
                    // utility classes (`div.flex.items-center.gap-1`), which is styling, not a
                    // contract: a restyle that changed no behaviour broke the spec, and the
                    // spec's failure said "element not found" rather than what actually moved.
                    data-testid={`board-stats-status-${col.name}`}
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium ${cfg.text} ${cfg.bg} border border-gray-200 dark:border-gray-700`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${cfg.bar} shrink-0`} />
                    <span>{col.name}</span>
                    <span className="font-bold" data-testid={`board-stats-status-count-${col.name}`}>{col.count}</span>
                  </div>
                );
              })}
            </div>
            {/* Commits (active-profile badges live on the always-visible pulse line) */}
            {commitCount !== null && commitCount > 0 && (
              <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-gray-100 dark:border-gray-800">
                <span
                  data-testid="board-stats-commits"
                  className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"
                  title={commitBranch ? `Commits on ${commitBranch}` : "Commits on default branch"}
                >
                  <Icon className="w-3 h-3 text-gray-400 dark:text-gray-500">
                    <circle cx="12" cy="12" r="3" /><line x1="12" y1="3" x2="12" y2="9" /><line x1="12" y1="15" x2="12" y2="21" />
                  </Icon>
                  {commitCount.toLocaleString('en-US')} commits
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Backlog count moved onto the Backlog view tab in BoardToolbar (#118) so
          it shares the Board tab's inline activity-summary treatment — one
          consistent tab-header pattern instead of a standalone pill here. */}

      {/* Agents running (#1162): the ONE agent count in the header. Kind and profile split are
          one click away, and per-profile counts include running agents only. */}
      <AgentsRunningChip agents={agents} />
    </div>
  );
}

const KIND_DOT: Record<AgentKind, string> = {
  building: "bg-indigo-500",
  reviewing: "bg-accent-500",
  fixing: "bg-amber-500",
};

function AgentsRunningChip({ agents }: { agents: AgentActivity }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismissable(ref, open, () => setOpen(false));
  const live = agents.running > 0;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        data-testid="board-stats-agents"
        data-running={agents.running}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={describeAgentActivity(agents)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border transition-colors whitespace-nowrap ${
          live
            ? "bg-indigo-50 dark:bg-indigo-950 border-indigo-200 dark:border-indigo-800 hover:bg-indigo-100 dark:hover:bg-indigo-900"
            : "bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700"
        }`}
      >
        {live ? (
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500" />
          </span>
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-gray-400 shrink-0" />
        )}
        <span className={`text-xs ${live ? "text-indigo-700 dark:text-indigo-300" : "text-gray-500 dark:text-gray-400"}`}>
          {live ? (
            <>
              <span className="font-semibold">{agents.running}</span> agent{agents.running === 1 ? "" : "s"} running
            </>
          ) : "no agents running"}
        </span>
        <Icon className={`w-2.5 h-2.5 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} d="m19.5 8.25-7.5 7.5-7.5-7.5" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Agents running"
          data-testid="board-stats-agents-popover"
          className="absolute top-full left-0 mt-1 z-30 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 shadow-lg flex flex-col gap-2 text-xs text-gray-700 dark:text-gray-300"
        >
          <div className="font-semibold text-gray-800 dark:text-gray-100">{formatAgentsRunning(agents.running)}</div>
          {live && (
            <>
              <div className="flex flex-col gap-1">
                {(Object.keys(AGENT_KIND_LABEL) as AgentKind[]).map((kind) => (
                  <div key={kind} className="flex items-center justify-between" data-testid={`board-stats-agents-kind-${kind}`}>
                    <span className="flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${KIND_DOT[kind]}`} />
                      {AGENT_KIND_LABEL[kind]}
                    </span>
                    <span className="font-semibold tabular-nums">{agents.byKind[kind]}</span>
                  </div>
                ))}
              </div>
              {agents.byProfile.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap pt-2 border-t border-gray-100 dark:border-gray-800">
                  <span className="text-[11px] text-gray-500 dark:text-gray-400">By profile:</span>
                  {agents.byProfile.map(({ profile, count }) => (
                    <span
                      key={profile}
                      data-testid={`board-stats-agents-profile-${profile}`}
                      title={`${count} running agent${count === 1 ? "" : "s"} on profile ${profile}`}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-brand-50 dark:bg-brand-900/40 border border-brand-200 dark:border-brand-700 text-brand-700 dark:text-brand-300"
                    >
                      <span className="max-w-[120px] truncate">{profile}</span>
                      <span className="font-semibold">{count}</span>
                    </span>
                  ))}
                </div>
              )}
              {agents.outsideInProgress > 0 && (
                <div className="text-[11px] text-gray-500 dark:text-gray-400">
                  {agents.outsideInProgress} of them on tickets outside In Progress, so not in WIP.
                </div>
              )}
            </>
          )}
          <p className="text-[10px] text-gray-400 dark:text-gray-500 leading-snug pt-2 border-t border-gray-100 dark:border-gray-800">
            {PULSE_TERMS.agentsRunning}
          </p>
        </div>
      )}
    </div>
  );
}
