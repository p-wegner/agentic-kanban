import { useEffect, useRef, useState } from "react";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";

interface BoardStatsProps {
  activeColumns: StatusWithIssues[];
  archiveColumns: StatusWithIssues[];
  searchQuery: string;
  projectId?: string;
  showBlocked?: boolean;
  onToggleBlocked?: () => void;
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

function getConfig(name: string) {
  return STATUS_CONFIG[name] ?? DEFAULT_CONFIG;
}

export function BoardStats({
  activeColumns,
  archiveColumns,
  searchQuery,
  projectId,
  showBlocked,
  onToggleBlocked,
}: BoardStatsProps) {
  const isFiltered = !!searchQuery;
  const allColumns = [...activeColumns, ...archiveColumns];
  const totalActive = activeColumns.reduce((sum, col) => sum + col.issues.length, 0);
  const totalArchive = archiveColumns.reduce((sum, col) => sum + col.issues.length, 0);
  const total = totalActive + totalArchive;

  const doneCount = archiveColumns.find((c) => c.name === "Done")?.issues.length ?? 0;
  const cancelledCount = archiveColumns.find((c) => c.name === "Cancelled")?.issues.length ?? 0;
  const nonCancelledTotal = total - cancelledCount;
  const completionPct = nonCancelledTotal > 0 ? Math.round((doneCount / nonCancelledTotal) * 100) : 0;

  // Active workspace counts
  const activeWorkspaces = activeColumns.reduce((sum, col) => {
    return sum + col.issues.filter((i) => {
      const ws = i.workspaceSummary?.main;
      return ws?.status === "active" || ws?.status === "reviewing";
    }).length;
  }, 0);

  const profileCounts = new Map<string, number>();
  for (const col of activeColumns) {
    for (const issue of col.issues) {
      const wsMain = (issue as any).workspaceSummary?.main;
      // Prefer tagged profile, fall back to legacy claudeProfile string
      const profile = wsMain?.profile?.name ?? wsMain?.claudeProfile;
      if (profile) profileCounts.set(profile, (profileCounts.get(profile) ?? 0) + 1);
    }
  }

  const [commitCount, setCommitCount] = useState<number | null>(null);
  const [commitBranch, setCommitBranch] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    apiFetch<{ commitCount: number; detectedBranch: string | null }>(`/api/projects/${projectId}/stats`)
      .then((s) => { setCommitCount(s.commitCount); setCommitBranch(s.detectedBranch); })
      .catch(() => {});
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
  useEffect(() => {
    if (!showBreakdown) return;
    function handleClick(e: MouseEvent) {
      if (breakdownRef.current && !breakdownRef.current.contains(e.target as Node)) setShowBreakdown(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setShowBreakdown(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [showBreakdown]);

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
          title={total > 0 ? `${doneCount} of ${nonCancelledTotal} done (${completionPct}%) — click for full breakdown` : "Board breakdown"}
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
            <>
              <span key={popKey} className={`text-sm font-bold text-gray-800 dark:text-gray-100 ${popKey > 0 ? "count-pop" : ""}`}>
                {totalActive}
              </span>
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">open</span>
              {doneCount > 0 && (
                <span className="text-xs text-gray-400 dark:text-gray-500">· {doneCount} done</span>
              )}
            </>
          )}
          <svg className={`w-2.5 h-2.5 text-gray-400 transition-transform ${showBreakdown ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
          </svg>
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
                  if (col.issues.length === 0) return null;
                  const pct = (col.issues.length / total) * 100;
                  const cfg = getConfig(col.name);
                  return (
                    <div
                      key={col.id}
                      className={`${cfg.bar} transition-all duration-300`}
                      style={{ width: `${pct}%` }}
                      title={`${col.name}: ${col.issues.length} (${Math.round(pct)}%)`}
                    />
                  );
                })}
              </div>
            )}
            {/* Per-status legend */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {allColumns.map((col) => {
                const cfg = getConfig(col.name);
                if (col.issues.length === 0) return null;
                return (
                  <div
                    key={col.id}
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium ${cfg.text} ${cfg.bg} border border-gray-200 dark:border-gray-700`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${cfg.bar} shrink-0`} />
                    <span>{col.name}</span>
                    <span className="font-bold">{col.issues.length}</span>
                  </div>
                );
              })}
            </div>
            {/* Commits (active-profile badges live on the always-visible pulse line) */}
            {commitCount !== null && commitCount > 0 && (
              <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-gray-100 dark:border-gray-800">
                <span className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400" title={commitBranch ? `Commits on ${commitBranch}` : "Commits on default branch"}>
                  <svg className="w-3 h-3 text-gray-400 dark:text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <circle cx="12" cy="12" r="3" /><line x1="12" y1="3" x2="12" y2="9" /><line x1="12" y1="15" x2="12" y2="21" />
                  </svg>
                  {commitCount.toLocaleString('en-US')} commits
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Active agents — live, changing signal stays on the pulse line */}
      {activeWorkspaces > 0 && (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-indigo-50 dark:bg-indigo-950 border border-indigo-200 dark:border-indigo-800">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500" />
          </span>
          <span className="text-xs font-semibold text-indigo-700 dark:text-indigo-300">{activeWorkspaces}</span>
          <span className="text-xs text-indigo-600 dark:text-indigo-400">active</span>
        </div>
      )}

      {/* Active agent profiles — live signal, always visible at every screen size */}
      {[...profileCounts.entries()].map(([profile, count]) => (
        <div key={profile} className="flex items-center gap-1 px-2 py-1 rounded-full bg-brand-50 dark:bg-brand-900/40 border border-brand-200 dark:border-brand-700" title={`${count} active ${profile} agent${count === 1 ? "" : "s"}`}>
          <span className="w-1.5 h-1.5 rounded-full bg-brand-500 shrink-0" />
          <span className="text-xs text-brand-700 dark:text-brand-300 max-w-[120px] truncate">{profile}</span>
          <span className="text-xs font-semibold text-brand-700 dark:text-brand-300">{count}</span>
        </div>
      ))}

      {/* Blocked filter */}
      {onToggleBlocked && (
        <button
          onClick={onToggleBlocked}
          title="Show only blocked issues"
          className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors border ${
            showBlocked
              ? "bg-amber-100 text-amber-700 border-amber-300"
              : "bg-gray-50 dark:bg-gray-950 text-gray-400 dark:text-gray-500 border-gray-200 dark:border-gray-700 hover:text-gray-600 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600"
          }`}
        >
          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
            <path d="M8 1a2 2 0 0 1 2 2v4H6V3a2 2 0 0 1 2-2zm3 6V3a3 3 0 0 0-6 0v4a2 2 0 0 0 2 2v2.5a.5.5 0 0 0 1 0V9a2 2 0 0 0 2-2z"/>
          </svg>
          <span className="hidden sm:inline">Blocked</span>
        </button>
      )}
    </div>
  );
}
