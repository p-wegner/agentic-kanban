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
  "In Review":   { bar: "bg-blue-400",    dot: "bg-blue-300",    text: "text-blue-700",    bg: "bg-blue-50" },
  "AI Reviewed": { bar: "bg-purple-400",  dot: "bg-purple-300",  text: "text-purple-700",  bg: "bg-purple-50" },
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
      const profile = (issue as any).workspaceSummary?.main?.claudeProfile;
      if (profile) profileCounts.set(profile, (profileCounts.get(profile) ?? 0) + 1);
    }
  }

  const [commitCount, setCommitCount] = useState<number | null>(null);

  useEffect(() => {
    if (!projectId) return;
    apiFetch<{ commitCount: number }>(`/api/projects/${projectId}/stats`)
      .then((s) => setCommitCount(s.commitCount))
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

  return (
    <div data-testid="board-stats-bar" className="flex flex-col gap-2 w-full select-none">
      {/* Summary row */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Completion ring + total */}
        <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-gray-100 border border-gray-200">
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
          <span
            key={popKey}
            className={`inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded-full text-[10px] font-bold text-white ${
              isFiltered ? "bg-violet-500" : "bg-gray-600"
            } ${popKey > 0 ? "count-pop" : ""}`}
          >
            {total}
          </span>
          <span className="text-xs font-medium text-gray-600">
            {isFiltered ? "filtered" : "tickets"}
          </span>
          {total > 0 && (
            <span className="text-xs font-semibold text-emerald-600">{completionPct}%</span>
          )}
        </div>

        {/* Done count badge */}
        {doneCount > 0 && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-200">
            <svg className="w-3 h-3 text-emerald-500" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2}>
              <polyline points="2,6 5,9 10,3" />
            </svg>
            <span className="text-xs font-semibold text-emerald-700">{doneCount} done</span>
          </div>
        )}

        {/* Active agents badge */}
        {activeWorkspaces > 0 && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-indigo-50 border border-indigo-200">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500" />
            </span>
            <span className="text-xs font-semibold text-indigo-700">{activeWorkspaces}</span>
            <span className="text-xs text-indigo-600">active</span>
          </div>
        )}

        {/* Commit count */}
        {commitCount !== null && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-50 border border-gray-200" title="Commits on main branch">
            <svg className="w-3 h-3 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="12" r="3" /><line x1="12" y1="3" x2="12" y2="9" /><line x1="12" y1="15" x2="12" y2="21" />
            </svg>
            <span className="text-xs text-gray-500">{commitCount.toLocaleString()} commits</span>
          </div>
        )}

        {/* Profile badges */}
        {[...profileCounts.entries()].map(([profile, count]) => (
          <div key={profile} className="flex items-center gap-1 px-2 py-1 rounded-full bg-violet-50 border border-violet-200" title="Active profile">
            <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />
            <span className="text-xs text-violet-600 hidden sm:inline">{profile}</span>
            <span className="text-xs font-semibold text-violet-700">{count}</span>
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
                : "bg-gray-50 text-gray-400 border-gray-200 hover:text-gray-600 hover:border-gray-300"
            }`}
          >
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
              <path d="M8 1a2 2 0 0 1 2 2v4H6V3a2 2 0 0 1 2-2zm3 6V3a3 3 0 0 0-6 0v4a2 2 0 0 0 2 2v2.5a.5.5 0 0 0 1 0V9a2 2 0 0 0 2-2z"/>
            </svg>
            Blocked
          </button>
        )}
      </div>

      {/* Done / total progress bar */}
      {total > 0 && (
        <div
          className="h-1.5 w-full rounded-full overflow-hidden bg-gray-200"
          title={`${doneCount} / ${nonCancelledTotal} non-cancelled issues done (${completionPct}%)`}
        >
          <div
            className="h-full bg-emerald-500 rounded-full transition-all duration-500"
            style={{ width: `${completionPct}%` }}
          />
        </div>
      )}

      {/* Segmented progress bar + status legend */}
      {total > 0 && (
        <div className="flex items-center gap-3">
          <div className="flex h-3 rounded-full overflow-hidden gap-px flex-1 bg-gray-100 shadow-inner">
            {allColumns.map((col) => {
              if (col.issues.length === 0) return null;
              const pct = (col.issues.length / total) * 100;
              const cfg = getConfig(col.name);
              return (
                <div
                  key={col.id}
                  className={`${cfg.bar} transition-all duration-300 relative group`}
                  style={{ width: `${pct}%` }}
                  title={`${col.name}: ${col.issues.length} (${Math.round(pct)}%)`}
                />
              );
            })}
          </div>
          {/* Status legend pills */}
          <div className="flex items-center gap-1.5 flex-wrap shrink-0">
            {allColumns.map((col) => {
              const cfg = getConfig(col.name);
              const isActive = col.issues.length > 0;
              if (!isActive) return null;
              return (
                <div
                  key={col.id}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium ${cfg.text} ${cfg.bg} border border-gray-200`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${cfg.bar} shrink-0`} />
                  <span className="hidden sm:inline">{col.name}</span>
                  <span className="font-bold">{col.issues.length}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
