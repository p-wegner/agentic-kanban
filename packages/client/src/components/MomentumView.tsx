import { useMemo, useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { PRIORITY_META } from "../lib/chartColors.js";

export interface MomentumViewProps {
  columns: StatusWithIssues[];
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery?: string;
}

const STATUS_ORDER = ["Todo", "In Progress", "In Review", "Done", "Cancelled"];
const STATUS_BADGE: Record<string, string> = {
  "Todo": "bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  "In Progress": "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  "In Review": "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300",
  "Done": "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
  "Cancelled": "bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-300",
};

const PRIORITY_LANE: Record<string, { bg: string; border: string; glow: string; label: string; dot: string }> = {
  critical: {
    bg: "bg-red-50 dark:bg-red-950/30",
    border: "border-red-300 dark:border-red-700",
    glow: "shadow-red-200 dark:shadow-red-900",
    label: "text-red-600 dark:text-red-400",
    dot: "bg-red-500",
  },
  high: {
    bg: "bg-orange-50 dark:bg-orange-950/30",
    border: "border-orange-300 dark:border-orange-700",
    glow: "shadow-orange-200 dark:shadow-orange-900",
    label: "text-orange-600 dark:text-orange-400",
    dot: "bg-orange-400",
  },
  medium: {
    bg: "bg-amber-50 dark:bg-amber-950/30",
    border: "border-amber-200 dark:border-amber-700",
    glow: "shadow-amber-100 dark:shadow-amber-950",
    label: "text-amber-600 dark:text-amber-400",
    dot: "bg-amber-400",
  },
  low: {
    bg: "bg-sky-50 dark:bg-sky-950/30",
    border: "border-sky-200 dark:border-sky-700",
    glow: "shadow-sky-100 dark:shadow-sky-950",
    label: "text-sky-600 dark:text-sky-400",
    dot: "bg-sky-400",
  },
};

const PRIORITY_KEYS = ["critical", "high", "medium", "low"] as const;

function getStatusWeight(statusName: string): number {
  const idx = STATUS_ORDER.indexOf(statusName);
  return idx === -1 ? 0 : idx;
}

function IssueCard({
  issue,
  statusName,
  onClick,
}: {
  issue: IssueWithStatus;
  statusName: string;
  onClick: () => void;
}) {
  const priority = issue.priority ?? "low";
  const lane = PRIORITY_LANE[priority] ?? PRIORITY_LANE.low;
  const badge = STATUS_BADGE[statusName] ?? "bg-gray-100 text-gray-600";

  // Progress bar width based on status position
  const progress = Math.round(
    ((getStatusWeight(statusName) + 0.5) / STATUS_ORDER.length) * 100
  );

  return (
    <button
      onClick={onClick}
      className={`
        group relative flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left
        transition-all duration-200 cursor-pointer min-w-[180px] max-w-[220px] flex-shrink-0
        hover:-translate-y-0.5 hover:shadow-md
        ${lane.bg} ${lane.border} ${lane.glow}
        focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-brand-500
      `}
    >
      {/* Issue number + title */}
      <div className="flex items-start gap-1.5">
        <span className={`text-[10px] font-mono font-bold mt-0.5 shrink-0 ${lane.label}`}>
          #{issue.issueNumber}
        </span>
        <span className="text-xs font-medium text-gray-800 dark:text-gray-100 line-clamp-2 leading-snug">
          {issue.title}
        </span>
      </div>

      {/* Status badge + type */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${badge}`}>
          {statusName}
        </span>
        {issue.issueType && issue.issueType !== "task" && (
          <span className="text-[9px] text-gray-400 dark:text-gray-500 capitalize">
            {issue.issueType}
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div className="h-0.5 w-full rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${lane.dot}`}
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Tags */}
      {issue.tags && issue.tags.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {issue.tags.slice(0, 3).map((tag) => (
            <span
              key={tag.id}
              className="text-[8px] rounded px-1 py-0.5 bg-black/5 dark:bg-white/5 text-gray-500 dark:text-gray-400"
            >
              {tag.name}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

export function MomentumView({ columns, onIssueClick, searchQuery = "" }: MomentumViewProps) {
  const [hideDone, setHideDone] = useState(true);

  const issuesByPriority = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const result: Record<string, Array<{ issue: IssueWithStatus; statusName: string }>> = {
      critical: [],
      high: [],
      medium: [],
      low: [],
    };

    for (const col of columns) {
      if (hideDone && (col.name === "Done" || col.name === "Cancelled")) continue;
      for (const issue of col.issues) {
        if (q && !issue.title.toLowerCase().includes(q) && !String(issue.issueNumber).includes(q)) {
          continue;
        }
        const p = issue.priority ?? "low";
        if (result[p]) {
          result[p].push({ issue, statusName: col.name });
        } else {
          result.low.push({ issue, statusName: col.name });
        }
      }
    }

    // Sort each lane by status progress so issues flow Todo → Done
    for (const key of PRIORITY_KEYS) {
      result[key].sort(
        (a, b) => getStatusWeight(a.statusName) - getStatusWeight(b.statusName)
      );
    }

    return result;
  }, [columns, searchQuery, hideDone]);

  const totalIssues = PRIORITY_KEYS.reduce((n, k) => n + issuesByPriority[k].length, 0);
  const priorityMeta = Object.fromEntries(PRIORITY_META.map((p) => [p.key, p]));

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shrink-0">
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Momentum</h2>
            <p className="text-[11px] text-gray-400 dark:text-gray-500">
              {totalIssues} issue{totalIssues !== 1 ? "s" : ""} flowing across priority lanes
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Status pipeline legend */}
          <div className="hidden md:flex items-center gap-1.5 text-[10px] text-gray-400 dark:text-gray-500">
            {STATUS_ORDER.slice(0, 4).map((s, i) => (
              <span key={s} className="flex items-center gap-1">
                {i > 0 && <span className="opacity-40">›</span>}
                <span>{s}</span>
              </span>
            ))}
          </div>

          <button
            onClick={() => setHideDone((v) => !v)}
            className={`
              text-[10px] px-2.5 py-1 rounded-full border transition-colors font-medium
              ${hideDone
                ? "border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500"
                : "border-emerald-400 dark:border-emerald-600 text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30"
              }
            `}
          >
            {hideDone ? "Show Done" : "Hide Done"}
          </button>
        </div>
      </div>

      {/* Priority lanes */}
      <div className="flex flex-1 min-h-0 flex-col overflow-y-auto divide-y divide-gray-200 dark:divide-gray-800">
        {PRIORITY_KEYS.map((priority) => {
          const items = issuesByPriority[priority];
          const lane = PRIORITY_LANE[priority];
          const meta = priorityMeta[priority];

          return (
            <div key={priority} className="flex min-h-[120px] shrink-0">
              {/* Lane label — sticky left */}
              <div
                className={`
                  flex flex-col items-center justify-start gap-2 pt-4 px-3 w-[72px] shrink-0
                  border-r border-gray-200 dark:border-gray-800
                  bg-white dark:bg-gray-900
                `}
              >
                <div className={`w-2.5 h-2.5 rounded-full ${lane.dot}`} />
                <span
                  className={`text-[10px] font-semibold uppercase tracking-widest writing-mode-vertical ${lane.label}`}
                  style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", letterSpacing: "0.1em" }}
                >
                  {priority}
                </span>
                <span className="text-[10px] text-gray-400 dark:text-gray-600 font-mono">
                  {items.length}
                </span>
              </div>

              {/* Scrollable card river */}
              <div className={`flex-1 overflow-x-auto ${lane.bg}`}>
                {items.length === 0 ? (
                  <div className="flex items-center justify-center h-full min-h-[100px]">
                    <span className={`text-[11px] ${lane.label} opacity-40`}>
                      No {priority} issues
                    </span>
                  </div>
                ) : (
                  <div className="flex gap-2.5 px-4 py-3 min-w-max items-start">
                    {items.map(({ issue, statusName }) => (
                      <IssueCard
                        key={issue.id}
                        issue={issue}
                        statusName={statusName}
                        onClick={() => onIssueClick(issue)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer stats */}
      <div className="shrink-0 flex items-center gap-4 px-5 py-2 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        {PRIORITY_KEYS.map((p) => {
          const count = issuesByPriority[p].length;
          const lane = PRIORITY_LANE[p];
          return (
            <div key={p} className="flex items-center gap-1.5">
              <div className={`w-2 h-2 rounded-full ${lane.dot}`} />
              <span className={`text-[10px] font-mono ${lane.label}`}>{count}</span>
              <span className="text-[10px] text-gray-400 dark:text-gray-500 capitalize">{p}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
