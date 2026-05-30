import { useMemo, useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { STATUS_COLORS } from "../lib/chartColors";

const ARCHIVE_STATUS_NAMES = new Set(["Done", "Cancelled", "Backlog"]);

const PRIORITY_LANES = [
  {
    key: "critical",
    label: "Critical",
    color: "#ef4444",
    headerBg: "bg-red-50 dark:bg-red-950/40",
    headerBorder: "border-red-200 dark:border-red-800",
    headerText: "text-red-700 dark:text-red-400",
    dot: "bg-red-500",
    cellBg: "bg-red-50/30 dark:bg-red-950/10",
  },
  {
    key: "high",
    label: "High",
    color: "#f97316",
    headerBg: "bg-orange-50 dark:bg-orange-950/40",
    headerBorder: "border-orange-200 dark:border-orange-800",
    headerText: "text-orange-700 dark:text-orange-400",
    dot: "bg-orange-500",
    cellBg: "bg-orange-50/30 dark:bg-orange-950/10",
  },
  {
    key: "medium",
    label: "Medium",
    color: "#eab308",
    headerBg: "bg-yellow-50 dark:bg-yellow-950/40",
    headerBorder: "border-yellow-200 dark:border-yellow-800",
    headerText: "text-yellow-700 dark:text-yellow-400",
    dot: "bg-yellow-400",
    cellBg: "bg-yellow-50/30 dark:bg-yellow-950/10",
  },
  {
    key: "low",
    label: "Low",
    color: "#94a3b8",
    headerBg: "bg-slate-50 dark:bg-slate-800/40",
    headerBorder: "border-slate-200 dark:border-slate-700",
    headerText: "text-slate-600 dark:text-slate-400",
    dot: "bg-slate-400",
    cellBg: "bg-slate-50/20 dark:bg-slate-800/10",
  },
];

function WorkspaceStatusDot({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    active: "bg-green-500 animate-pulse",
    fixing: "bg-orange-500 animate-pulse",
    reviewing: "bg-accent-500 animate-pulse",
    idle: "bg-ink-faint",
    merging: "bg-accent-400",
  };
  const cls = colorMap[status];
  if (!cls) return null;
  return <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${cls}`} />;
}

interface SwimlaneCardProps {
  issue: IssueWithStatus;
  onClick: (issue: IssueWithStatus) => void;
}

function SwimlaneCard({ issue, onClick }: SwimlaneCardProps) {
  const ws = issue.workspaceSummary?.main;
  const isBlocked = issue.isBlocked;

  return (
    <button
      onClick={() => onClick(issue)}
      className={`w-full text-left bg-white dark:bg-gray-900 border rounded-lg px-3 py-2.5 text-xs shadow-sm hover:shadow-md transition-all group cursor-pointer
        ${isBlocked
          ? "border-red-300 dark:border-red-700"
          : "border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600"
        }`}
    >
      <div className="flex items-start gap-1.5 min-w-0">
        {ws && <WorkspaceStatusDot status={ws.status} />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 mb-1">
            <span className="text-[10px] text-gray-400 dark:text-gray-500 font-mono shrink-0">
              #{issue.issueNumber}
            </span>
            {issue.issueType && issue.issueType !== "task" && (
              <span className={`text-[9px] px-1 rounded font-medium shrink-0 ${
                issue.issueType === "bug" ? "bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300" :
                issue.issueType === "feature" ? "bg-violet-100 dark:bg-violet-900/50 text-violet-700 dark:text-violet-300" :
                "bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300"
              }`}>
                {issue.issueType}
              </span>
            )}
          </div>
          <p className="text-gray-800 dark:text-gray-200 font-medium leading-snug line-clamp-2 group-hover:text-blue-700 dark:group-hover:text-blue-400 transition-colors">
            {issue.title}
          </p>
          {ws && ws.status !== "closed" && (
            <div className="mt-1.5 flex items-center gap-1">
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                ws.status === "active" || ws.status === "fixing" ? "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400" :
                ws.status === "reviewing" ? "bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-400" :
                ws.status === "idle" ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400" :
                "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
              }`}>
                {ws.status}
              </span>
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

interface SwimlaneViewProps {
  columns: StatusWithIssues[];
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery?: string;
}

export function SwimlaneView({ columns, onIssueClick, searchQuery = "" }: SwimlaneViewProps) {
  const [collapsedLanes, setCollapsedLanes] = useState<Set<string>>(new Set());

  const activeColumns = useMemo(
    () => columns.filter((col) => !ARCHIVE_STATUS_NAMES.has(col.name)),
    [columns]
  );

  const filteredColumns = useMemo(() => {
    if (!searchQuery.trim()) return activeColumns;
    const q = searchQuery.toLowerCase();
    return activeColumns.map((col) => ({
      ...col,
      issues: col.issues.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          String(i.issueNumber).includes(q)
      ),
    }));
  }, [activeColumns, searchQuery]);

  const issuesByPriorityAndStatus = useMemo(() => {
    const map: Record<string, Record<string, IssueWithStatus[]>> = {};
    for (const lane of PRIORITY_LANES) {
      map[lane.key] = {};
      for (const col of filteredColumns) {
        map[lane.key][col.id] = col.issues.filter(
          (i) => (i.priority ?? "medium") === lane.key
        );
      }
    }
    return map;
  }, [filteredColumns]);

  const laneIssueCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const lane of PRIORITY_LANES) {
      counts[lane.key] = filteredColumns.reduce(
        (sum, col) => sum + (issuesByPriorityAndStatus[lane.key]?.[col.id]?.length ?? 0),
        0
      );
    }
    return counts;
  }, [filteredColumns, issuesByPriorityAndStatus]);

  const totalIssues = useMemo(
    () => filteredColumns.reduce((sum, col) => sum + col.issues.length, 0),
    [filteredColumns]
  );

  function toggleLane(key: string) {
    setCollapsedLanes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (totalIssues === 0 && !searchQuery) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-3 text-gray-400 dark:text-gray-500">
        <svg className="w-12 h-12 opacity-25" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
        </svg>
        <p className="text-sm">No active issues to display</p>
      </div>
    );
  }

  const LANE_HEADER_W = 100;

  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="min-w-max">
        {/* Column headers */}
        <div
          className="flex items-center sticky top-0 z-10 bg-gray-50 dark:bg-gray-950 border-b border-gray-200 dark:border-gray-700"
          style={{ paddingLeft: LANE_HEADER_W }}
        >
          {filteredColumns.map((col) => {
            const color = STATUS_COLORS[col.name];
            return (
              <div
                key={col.id}
                className="flex items-center gap-2 px-3 py-2.5 min-w-[180px] w-[220px] border-l border-gray-200 dark:border-gray-700"
              >
                {color && (
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: color }}
                  />
                )}
                <span className="text-xs font-semibold text-gray-700 dark:text-gray-200 truncate">
                  {col.name}
                </span>
                <span className="ml-auto text-[10px] text-gray-400 dark:text-gray-500 font-mono shrink-0">
                  {col.issues.length}
                </span>
              </div>
            );
          })}
        </div>

        {/* Priority lanes */}
        {PRIORITY_LANES.map((lane) => {
          const count = laneIssueCounts[lane.key] ?? 0;
          const collapsed = collapsedLanes.has(lane.key);

          return (
            <div key={lane.key} className="flex border-b border-gray-200 dark:border-gray-700 last:border-b-0">
              {/* Lane header */}
              <button
                onClick={() => toggleLane(lane.key)}
                className={`flex items-center gap-2.5 px-3 py-2 sticky left-0 z-[5] self-stretch text-left shrink-0
                  ${lane.headerBg} border-r ${lane.headerBorder} transition-colors hover:brightness-95`}
                style={{ width: LANE_HEADER_W, minWidth: LANE_HEADER_W }}
                title={collapsed ? `Expand ${lane.label}` : `Collapse ${lane.label}`}
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${lane.dot}`} />
                <span className={`text-[10px] font-bold uppercase tracking-wider ${lane.headerText}`}>
                  {lane.label}
                </span>
                <span className={`ml-auto text-[10px] font-mono ${lane.headerText} opacity-70`}>
                  {count}
                </span>
                <svg
                  className={`w-3 h-3 ${lane.headerText} transition-transform shrink-0 ${collapsed ? "" : "rotate-180"}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* Cells row */}
              {!collapsed && (
                <div className="flex flex-1">
                  {filteredColumns.map((col) => {
                    const issues = issuesByPriorityAndStatus[lane.key]?.[col.id] ?? [];
                    return (
                      <div
                        key={col.id}
                        className={`min-w-[180px] w-[220px] border-l border-gray-200 dark:border-gray-700 p-2 min-h-[80px] ${lane.cellBg}`}
                      >
                        {issues.length === 0 ? (
                          <div className="h-full flex items-center justify-center">
                            <span className="text-[10px] text-gray-300 dark:text-gray-700 select-none">—</span>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-1.5">
                            {issues.map((issue) => (
                              <SwimlaneCard
                                key={issue.id}
                                issue={issue}
                                onClick={onIssueClick}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
