import { useEffect, useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import type { LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";

const WS_STATUS_CONFIG: Record<string, { label: string; dot: string; ring: string; header: string }> = {
  active:    { label: "Active",    dot: "bg-green-500 animate-pulse", ring: "ring-green-400/30", header: "from-green-50 dark:from-green-950/40" },
  fixing:    { label: "Fixing",   dot: "bg-orange-500 animate-pulse", ring: "ring-orange-400/30", header: "from-orange-50 dark:from-orange-950/40" },
  reviewing: { label: "Reviewing", dot: "bg-violet-500 animate-pulse", ring: "ring-violet-400/30", header: "from-violet-50 dark:from-violet-950/40" },
  idle:      { label: "Idle",      dot: "bg-gray-400", ring: "ring-gray-300/30", header: "from-gray-50 dark:from-gray-800/40" },
  closed:    { label: "Closed",    dot: "bg-gray-300", ring: "ring-gray-200/30", header: "from-gray-50 dark:from-gray-800/40" },
};

const STATUS_ORDER = ["active", "fixing", "reviewing", "idle"];

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function ElapsedTimer({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = now - new Date(since).getTime();
  return <span>{formatDuration(ms)}</span>;
}

interface AgentCardProps {
  issue: IssueWithStatus;
  liveActivity?: string;
  liveStats?: LiveSessionStats;
  todos?: TodoItem[];
  onIssueClick: (issue: IssueWithStatus) => void;
  onWorkspaceClick: (issue: IssueWithStatus, workspaceId?: string) => void;
}

function AgentCard({ issue, liveActivity, liveStats, todos, onIssueClick, onWorkspaceClick }: AgentCardProps) {
  const ws = issue.workspaceSummary?.main;
  if (!ws) return null;

  const cfg = WS_STATUS_CONFIG[ws.status] ?? WS_STATUS_CONFIG.idle;
  const isLive = ws.status === "active" || ws.status === "fixing" || ws.status === "reviewing";

  const doneTodos = todos?.filter((t) => t.status === "completed").length ?? 0;
  const totalTodos = todos?.length ?? 0;
  const inProgressTodo = todos?.find((t) => t.status === "in_progress");

  const diff = ws.diffStats;
  const tokens = liveStats?.contextTokens ?? ws.contextTokens ?? 0;
  const toolUses = liveStats?.toolUses;

  return (
    <div
      className={`flex flex-col bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 ring-2 ${cfg.ring} overflow-hidden shadow-sm hover:shadow-md transition-shadow`}
    >
      {/* Header */}
      <div
        className={`bg-gradient-to-r ${cfg.header} to-transparent px-3 pt-3 pb-2 border-b border-gray-100 dark:border-gray-800 flex items-start gap-2`}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono text-gray-400 dark:text-gray-500 shrink-0">
              #{issue.issueNumber}
            </span>
            <span className={`inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded-full ${cfg.ring.replace("/30", "/50")} bg-white/60 dark:bg-gray-900/60`}>
              <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
              {cfg.label}
            </span>
            {ws.profile?.name && (
              <span className="text-xs text-gray-400 dark:text-gray-500 truncate">{ws.profile.name}</span>
            )}
          </div>
          <button
            onClick={() => onIssueClick(issue)}
            className="text-sm font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 text-left line-clamp-2 leading-snug w-full"
          >
            {issue.title}
          </button>
        </div>
        <button
          onClick={() => onWorkspaceClick(issue, ws.id)}
          className="shrink-0 p-1 rounded text-gray-400 dark:text-gray-500 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors"
          title="Open workspace"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M9 21V9" />
          </svg>
        </button>
      </div>

      {/* Branch + duration */}
      <div className="px-3 py-1.5 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
        <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span className="truncate font-mono">{ws.branch}</span>
        {ws.lastSessionAt && (
          <span className="ml-auto shrink-0 tabular-nums">
            <ElapsedTimer since={ws.lastSessionAt} />
          </span>
        )}
      </div>

      {/* Live activity ticker */}
      <div className="px-3 py-2 min-h-[2.5rem] flex items-center">
        {liveActivity ? (
          <p className="text-xs text-gray-700 dark:text-gray-300 line-clamp-2 leading-relaxed">
            {liveActivity}
          </p>
        ) : ws.lastTool ? (
          <p className="text-xs text-gray-400 dark:text-gray-500 line-clamp-2 leading-relaxed italic">
            Last: {ws.lastTool}
          </p>
        ) : ws.lastAssistantMessage ? (
          <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2 leading-relaxed">
            {ws.lastAssistantMessage}
          </p>
        ) : (
          <p className="text-xs text-gray-300 dark:text-gray-600 italic">No activity yet</p>
        )}
      </div>

      {/* In-progress todo */}
      {inProgressTodo && (
        <div className="px-3 pb-2">
          <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 rounded px-2 py-1">
            <svg className="w-3 h-3 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
            <span className="truncate">{inProgressTodo.content}</span>
          </div>
        </div>
      )}

      {/* Stats footer */}
      <div className="px-3 py-2 mt-auto border-t border-gray-100 dark:border-gray-800 flex items-center gap-3 flex-wrap text-xs text-gray-500 dark:text-gray-400">
        {tokens > 0 && (
          <span className="flex items-center gap-1" title="Context tokens">
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4l2 2" />
            </svg>
            {formatTokens(tokens)}
          </span>
        )}
        {toolUses !== undefined && toolUses > 0 && (
          <span className="flex items-center gap-1" title="Tool uses">
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
            {toolUses}
          </span>
        )}
        {diff && (
          <span className="flex items-center gap-1" title="Diff stats">
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span className="text-emerald-600 dark:text-emerald-400">+{diff.insertions}</span>
            <span className="text-red-500 dark:text-red-400">-{diff.deletions}</span>
          </span>
        )}
        {totalTodos > 0 && (
          <span className="flex items-center gap-1 ml-auto" title="Todo progress">
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            <span className={doneTodos === totalTodos ? "text-green-600 dark:text-green-400" : ""}>
              {doneTodos}/{totalTodos}
            </span>
          </span>
        )}
        {isLive && liveStats?.subagentCount != null && liveStats.subagentCount > 0 && (
          <span className="flex items-center gap-1" title="Subagents">
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="9" cy="7" r="4" />
              <path d="M3 21v-2a4 4 0 0 1 4-4h4" />
              <circle cx="17" cy="17" r="3" />
              <path d="M17 14v6M14 17h6" />
            </svg>
            {liveStats.subagentCount}
          </span>
        )}
      </div>
    </div>
  );
}

export interface AgentGridProps {
  columns: StatusWithIssues[];
  liveActivity: Record<string, string>;
  liveStats: Record<string, LiveSessionStats>;
  sessionTodos: Record<string, TodoItem[]>;
  onIssueClick: (issue: IssueWithStatus) => void;
  onWorkspaceClick: (issue: IssueWithStatus, workspaceId?: string) => void;
}

export function AgentGrid({ columns, liveActivity, liveStats, sessionTodos, onIssueClick, onWorkspaceClick }: AgentGridProps) {
  // Gather all issues with non-closed workspaces, sorted by status priority then activity
  const agents = columns
    .flatMap((col) => col.issues)
    .filter((issue) => {
      const ws = issue.workspaceSummary?.main;
      return ws && ws.status !== "closed";
    })
    .sort((a, b) => {
      const aStatus = a.workspaceSummary?.main?.status ?? "idle";
      const bStatus = b.workspaceSummary?.main?.status ?? "idle";
      const aOrder = STATUS_ORDER.indexOf(aStatus);
      const bOrder = STATUS_ORDER.indexOf(bStatus);
      if (aOrder !== bOrder) return aOrder - bOrder;
      // Among same status, live activity first
      const aLive = liveActivity[a.id] ? 1 : 0;
      const bLive = liveActivity[b.id] ? 1 : 0;
      return bLive - aLive;
    });

  if (agents.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center h-full text-gray-400 dark:text-gray-500">
        <div className="text-center">
          <svg className="w-12 h-12 mx-auto mb-3 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <circle cx="12" cy="12" r="10" />
            <path d="M8 12h.01M12 12h.01M16 12h.01" />
          </svg>
          <p className="text-sm font-medium">No active agents</p>
          <p className="text-xs mt-1">Start a workspace to see live agent activity here</p>
        </div>
      </div>
    );
  }

  const liveCount = agents.filter(
    (i) => i.workspaceSummary?.main?.status === "active" || i.workspaceSummary?.main?.status === "fixing",
  ).length;

  return (
    <div className="flex flex-col gap-3 h-full overflow-y-auto p-1">
      {/* Summary bar */}
      <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 shrink-0 px-1">
        <span className="font-medium text-gray-700 dark:text-gray-300">{agents.length} workspace{agents.length !== 1 ? "s" : ""}</span>
        {liveCount > 0 && (
          <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            {liveCount} running
          </span>
        )}
      </div>

      {/* Responsive grid */}
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}
      >
        {agents.map((issue) => (
          <AgentCard
            key={issue.id}
            issue={issue}
            liveActivity={liveActivity[issue.id]}
            liveStats={liveStats[issue.id]}
            todos={sessionTodos[issue.id]}
            onIssueClick={onIssueClick}
            onWorkspaceClick={onWorkspaceClick}
          />
        ))}
      </div>
    </div>
  );
}
