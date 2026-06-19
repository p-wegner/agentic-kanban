import { useEffect, useMemo, useRef, useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import type { LiveSessionStats } from "../lib/useBoardEvents.js";

interface ActivityStripProps {
  columns: StatusWithIssues[];
  liveActivity: Record<string, string>;
  liveStats: Record<string, LiveSessionStats>;
  onIssueClick: (issue: IssueWithStatus) => void;
}

/** Strip of currently-active agents shown above the Butler chat. */
export function ActivityStrip({ columns, liveActivity, liveStats, onIssueClick }: ActivityStripProps) {
  const activeIssues = useMemo(() => {
    const result: IssueWithStatus[] = [];
    for (const col of columns) {
      for (const issue of col.issues) {
        const ws = issue.workspaceSummary?.main;
        if (ws && (ws.status === "active" || ws.status === "fixing" || ws.status === "reviewing")) {
          result.push(issue);
        }
      }
    }
    return result;
  }, [columns]);

  if (activeIssues.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 px-4 py-2 flex gap-2 flex-wrap items-center">
      <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 shrink-0">Active agents:</span>
      {activeIssues.map((issue) => {
        const ws = issue.workspaceSummary!.main!;
        const activity = liveActivity[issue.id];
        const stats = liveStats[issue.id];
        const statusDot = ws.status === "active" || ws.status === "fixing"
          ? "bg-green-500 animate-pulse"
          : "bg-accent-500";
        return (
          <button
            key={issue.id}
            onClick={() => onIssueClick(issue)}
            className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-surface-raised dark:bg-surface-raised-dark border border-gray-200 dark:border-gray-700 hover:border-brand-300 dark:hover:border-brand-600 text-xs text-gray-700 dark:text-gray-300 transition-colors max-w-[260px]"
            title={activity || `#${issue.issueNumber} ${issue.title}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot}`} />
            <span className="font-medium text-gray-500 dark:text-gray-400">#{issue.issueNumber}</span>
            <span className="truncate">{issue.title}</span>
            {stats && (
              <span className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500">
                {Math.round(stats.contextTokens / 1000)}k
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Inline input for renaming a butler tab (Enter commits, Escape cancels). */
export function TabRenameInput({ name, onSave, onCancel }: { name: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { ref.current?.select(); }, []);

  function commit() {
    const v = value.trim();
    if (v && v !== name) onSave(v);
    else onCancel();
  }

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        e.stopPropagation();
      }}
      className="w-20 rounded border border-brand-400 bg-white dark:bg-gray-800 px-1 text-xs text-gray-800 dark:text-gray-100 focus:outline-none"
      autoFocus
    />
  );
}
