import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import type { LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";

const MAX_HISTORY = 8;

const WS_STATUS_CONFIG: Record<string, { label: string; dot: string; ring: string; header: string; tier: "live" | "background" }> = {
  active:    { label: "Active",    dot: "bg-green-500 animate-pulse",  ring: "ring-green-400/40",  header: "from-green-50 dark:from-green-950/50",  tier: "live" },
  fixing:    { label: "Fixing",    dot: "bg-orange-500 animate-pulse", ring: "ring-orange-400/40", header: "from-orange-50 dark:from-orange-950/50", tier: "live" },
  reviewing: { label: "Reviewing", dot: "bg-violet-500 animate-pulse", ring: "ring-violet-400/30", header: "from-violet-50 dark:from-violet-950/40", tier: "background" },
  idle:      { label: "Idle",      dot: "bg-gray-400",                 ring: "ring-gray-300/30",   header: "from-gray-50 dark:from-gray-800/40",    tier: "background" },
  closed:    { label: "Closed",    dot: "bg-gray-300",                 ring: "ring-gray-200/30",   header: "from-gray-50 dark:from-gray-800/40",    tier: "background" },
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
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function ElapsedTimer({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span>{formatDuration(now - new Date(since).getTime())}</span>;
}

// --- Featured card (active / fixing) ----------------------------------------

const ATTENTION_CONFIG = {
  merge:    { label: "Ready to merge", dot: "bg-emerald-500", ring: "ring-emerald-400/60", header: "from-emerald-50 dark:from-emerald-950/50" },
  conflict: { label: "Conflicts",      dot: "bg-red-500",     ring: "ring-red-400/60",     header: "from-red-50 dark:from-red-950/50" },
} as const;

interface FeaturedCardProps {
  issue: IssueWithStatus;
  activityHistory: string[];
  liveStats?: LiveSessionStats;
  todos?: TodoItem[];
  attention?: "merge" | "conflict";
  onIssueClick: (issue: IssueWithStatus) => void;
  onWorkspaceClick: (issue: IssueWithStatus, workspaceId?: string) => void;
}

function FeaturedCard({ issue, activityHistory, liveStats, todos, attention, onIssueClick, onWorkspaceClick }: FeaturedCardProps) {
  const ws = issue.workspaceSummary?.main;
  const feedRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [activityHistory.length]);

  if (!ws) return null;

  const att = attention ? ATTENTION_CONFIG[attention] : null;
  const baseCfg = WS_STATUS_CONFIG[ws.status] ?? WS_STATUS_CONFIG.idle;
  const cfg = att ? { ...baseCfg, label: att.label, dot: att.dot, ring: att.ring, header: att.header } : baseCfg;

  const doneTodos = todos?.filter((t) => t.status === "completed").length ?? 0;
  const totalTodos = todos?.length ?? 0;
  const inProgressTodo = todos?.find((t) => t.status === "in_progress");
  const pendingTodos = todos?.filter((t) => t.status === "pending") ?? [];

  const diff = ws.diffStats;
  const tokens = liveStats?.contextTokens ?? ws.contextTokens ?? 0;
  const toolUses = liveStats?.toolUses;

  const displayHistory = activityHistory.length > 0
    ? activityHistory
    : ws.lastAssistantMessage
      ? [ws.lastAssistantMessage]
      : ws.lastTool
        ? [`Last: ${ws.lastTool}`]
        : [];

  return (
    <div className={`flex flex-col bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 ring-2 ${cfg.ring} overflow-hidden shadow-sm hover:shadow-md transition-shadow`}>
      <div className={`bg-gradient-to-r ${cfg.header} to-transparent px-3 pt-2.5 pb-2 border-b border-gray-100 dark:border-gray-800 flex items-start gap-2`}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-xs font-mono text-gray-400 dark:text-gray-500 shrink-0">#{issue.issueNumber}</span>
            <span className={`inline-flex items-center gap-1 text-xs font-semibold px-1.5 py-0.5 rounded-full bg-white/70 dark:bg-gray-900/70`}>
              <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
              {cfg.label}
            </span>
            {ws.profile?.name && (
              <span className="text-xs text-gray-400 dark:text-gray-500 truncate">{ws.profile.name}</span>
            )}
            {ws.lastSessionAt && (
              <span className="ml-auto text-xs tabular-nums text-gray-400 dark:text-gray-500 shrink-0">
                <ElapsedTimer since={ws.lastSessionAt} />
              </span>
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

      <div className="px-3 py-1 flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-800 font-mono">
        <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span className="truncate">{ws.branch}</span>
      </div>

      <div
        ref={feedRef}
        className="px-3 py-2 flex-1 overflow-y-auto min-h-[5rem] max-h-32 bg-gray-50 dark:bg-gray-950/50 font-mono"
        style={{ scrollbarWidth: "thin" } as React.CSSProperties}
      >
        {displayHistory.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {displayHistory.map((line, i) => (
              <p
                key={i}
                className={`text-xs leading-relaxed ${i === displayHistory.length - 1 ? "text-gray-800 dark:text-gray-200" : "text-gray-400 dark:text-gray-600"}`}
              >
                {i === displayHistory.length - 1 && (
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${cfg.dot} mr-1.5 mb-0.5 align-middle`} />
                )}
                {line}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-xs text-gray-300 dark:text-gray-600 italic">Waiting for activity...</p>
        )}
      </div>

      {inProgressTodo && (
        <div className="px-3 pt-1.5 pb-0">
          <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 rounded px-2 py-1">
            <svg className="w-3 h-3 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
            <span className="truncate">{inProgressTodo.content}</span>
          </div>
        </div>
      )}

      {pendingTodos.length > 0 && !inProgressTodo && (
        <div className="px-3 pt-1.5 pb-0">
          <p className="text-xs text-gray-400 dark:text-gray-500 truncate">
            Next: {pendingTodos[0].content}
          </p>
        </div>
      )}

      <div className="px-3 py-1.5 mt-auto border-t border-gray-100 dark:border-gray-800 flex items-center gap-3 flex-wrap text-xs text-gray-500 dark:text-gray-400">
        {tokens > 0 && (
          <span className="flex items-center gap-1" title="Context tokens">
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="10" /><path d="M12 8v4l2 2" /></svg>
            {formatTokens(tokens)}
          </span>
        )}
        {toolUses !== undefined && toolUses > 0 && (
          <span className="flex items-center gap-1" title="Tool uses">
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></svg>
            {toolUses}
          </span>
        )}
        {diff && (
          <span className="flex items-center gap-1" title={`${diff.filesChanged} file${diff.filesChanged !== 1 ? "s" : ""} changed`}>
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
            <span className="text-emerald-600 dark:text-emerald-400">+{diff.insertions}</span>
            <span className="text-red-500 dark:text-red-400">-{diff.deletions}</span>
          </span>
        )}
        {totalTodos > 0 && (
          <span className="flex items-center gap-1 ml-auto" title="Todo progress">
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
            <span className={doneTodos === totalTodos ? "text-green-600 dark:text-green-400 font-medium" : ""}>
              {doneTodos}/{totalTodos}
            </span>
            <span className="w-12 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden ml-0.5">
              <span
                className="block h-full bg-green-500 dark:bg-green-400 rounded-full transition-all"
                style={{ width: `${(doneTodos / totalTodos) * 100}%` }}
              />
            </span>
          </span>
        )}
        {liveStats?.subagentCount != null && liveStats.subagentCount > 0 && (
          <span className="flex items-center gap-1" title="Subagents">
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="9" cy="7" r="4" /><path d="M3 21v-2a4 4 0 0 1 4-4h4" /><circle cx="17" cy="17" r="3" /><path d="M17 14v6M14 17h6" /></svg>
            {liveStats.subagentCount}
          </span>
        )}
      </div>
    </div>
  );
}

// --- Compact card (reviewing / idle) -----------------------------------------

interface CompactCardProps {
  issue: IssueWithStatus;
  currentActivity?: string;
  liveStats?: LiveSessionStats;
  todos?: TodoItem[];
  onIssueClick: (issue: IssueWithStatus) => void;
  onWorkspaceClick: (issue: IssueWithStatus, workspaceId?: string) => void;
}

function CompactCard({ issue, currentActivity, liveStats, todos, onIssueClick, onWorkspaceClick }: CompactCardProps) {
  const ws = issue.workspaceSummary?.main;
  if (!ws) return null;

  const cfg = WS_STATUS_CONFIG[ws.status] ?? WS_STATUS_CONFIG.idle;
  const doneTodos = todos?.filter((t) => t.status === "completed").length ?? 0;
  const totalTodos = todos?.length ?? 0;
  const tokens = liveStats?.contextTokens ?? ws.contextTokens ?? 0;
  const diff = ws.diffStats;

  const activityText = currentActivity || ws.lastAssistantMessage || (ws.lastTool ? `Last: ${ws.lastTool}` : null);

  return (
    <div
      className={`flex flex-col bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 ring-1 ${cfg.ring} overflow-hidden shadow-sm hover:shadow-md transition-shadow cursor-pointer`}
      onClick={() => onIssueClick(issue)}
    >
      <div className={`bg-gradient-to-r ${cfg.header} to-transparent px-2.5 py-2 flex items-start gap-2`}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} shrink-0`} />
            <span className="text-xs font-mono text-gray-400 dark:text-gray-500">#{issue.issueNumber}</span>
            <span className="text-xs text-gray-500 dark:text-gray-400 font-medium truncate">{cfg.label}</span>
            {ws.lastSessionAt && (
              <span className="ml-auto text-xs tabular-nums text-gray-400 dark:text-gray-500 shrink-0">
                <ElapsedTimer since={ws.lastSessionAt} />
              </span>
            )}
          </div>
          <p className="text-xs font-semibold text-gray-800 dark:text-gray-200 line-clamp-1 leading-snug">{issue.title}</p>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onWorkspaceClick(issue, ws.id); }}
          className="shrink-0 p-0.5 rounded text-gray-300 dark:text-gray-600 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors"
          title="Open workspace"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" />
          </svg>
        </button>
      </div>

      {activityText && (
        <div className="px-2.5 py-1 border-t border-gray-100 dark:border-gray-800">
          <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1 font-mono leading-relaxed">{activityText}</p>
        </div>
      )}

      <div className="px-2.5 py-1.5 mt-auto border-t border-gray-100 dark:border-gray-800 flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
        {tokens > 0 && <span title="Context tokens">{formatTokens(tokens)}</span>}
        {diff && (
          <>
            <span className="text-emerald-600 dark:text-emerald-400">+{diff.insertions}</span>
            <span className="text-red-500 dark:text-red-400">-{diff.deletions}</span>
          </>
        )}
        {totalTodos > 0 && (
          <span className="flex items-center gap-1 ml-auto">
            <span className={doneTodos === totalTodos ? "text-green-600 dark:text-green-400" : ""}>{doneTodos}/{totalTodos}</span>
            <span className="w-8 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <span className="block h-full bg-green-500 dark:bg-green-400 rounded-full transition-all" style={{ width: `${(doneTodos / totalTodos) * 100}%` }} />
            </span>
          </span>
        )}
        {ws.readyForMerge && (
          <span className="ml-auto flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium" title="Ready to merge">
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path d="M20 6L9 17l-5-5" /></svg>
            Merge
          </span>
        )}
      </div>
    </div>
  );
}

// --- Public interface ---------------------------------------------------------

export interface AgentGridProps {
  columns: StatusWithIssues[];
  liveActivity: Record<string, string>;
  liveStats: Record<string, LiveSessionStats>;
  sessionTodos: Record<string, TodoItem[]>;
  onIssueClick: (issue: IssueWithStatus) => void;
  onWorkspaceClick: (issue: IssueWithStatus, workspaceId?: string) => void;
}

export function AgentGrid({ columns, liveActivity, liveStats, sessionTodos, onIssueClick, onWorkspaceClick }: AgentGridProps) {
  const historyRef = useRef<Map<string, string[]>>(new Map());
  const [, setHistoryTick] = useState(0);

  useEffect(() => {
    let changed = false;
    for (const [issueId, activity] of Object.entries(liveActivity)) {
      if (!activity) continue;
      const existing = historyRef.current.get(issueId) ?? [];
      if (existing[existing.length - 1] !== activity) {
        historyRef.current.set(issueId, [...existing, activity].slice(-MAX_HISTORY));
        changed = true;
      }
    }
    if (changed) setHistoryTick((n) => n + 1);
  }, [liveActivity]);

  const agents = columns
    .flatMap((col) => col.issues)
    .filter((issue) => {
      const ws = issue.workspaceSummary?.main;
      if (!ws || ws.status === "closed") return false;
      // Hide plan-only / zero-change idle workspaces (noise) — unless they still need a merge/conflict action.
      if (ws.status === "idle" && ws.planOnlyWarning && !ws.readyForMerge && !ws.conflicts?.hasConflicts) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const aStatus = a.workspaceSummary?.main?.status ?? "idle";
      const bStatus = b.workspaceSummary?.main?.status ?? "idle";
      const aOrder = STATUS_ORDER.indexOf(aStatus);
      const bOrder = STATUS_ORDER.indexOf(bStatus);
      if (aOrder !== bOrder) return aOrder - bOrder;
      const aLive = liveActivity[a.id] ? 1 : 0;
      const bLive = liveActivity[b.id] ? 1 : 0;
      return bLive - aLive;
    });

  if (agents.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center h-full text-gray-400 dark:text-gray-500">
        <div className="text-center">
          <svg className="w-12 h-12 mx-auto mb-3 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <circle cx="12" cy="12" r="10" /><path d="M8 12h.01M12 12h.01M16 12h.01" />
          </svg>
          <p className="text-sm font-medium">No active agents</p>
          <p className="text-xs mt-1">Start a workspace to see live agent activity here</p>
        </div>
      </div>
    );
  }

  // Idle workspaces that are done and waiting on a human action (merge or conflict resolution).
  const attentionAgents = agents.filter((i) => {
    const ws = i.workspaceSummary?.main;
    return ws?.status === "idle" && (ws.readyForMerge === true || ws.conflicts?.hasConflicts === true);
  });
  const isAttention = (i: IssueWithStatus) => attentionAgents.includes(i);

  const liveAgents = agents.filter((i) => !isAttention(i) && WS_STATUS_CONFIG[i.workspaceSummary?.main?.status ?? ""]?.tier === "live");
  const backgroundAgents = agents.filter((i) => !isAttention(i) && WS_STATUS_CONFIG[i.workspaceSummary?.main?.status ?? ""]?.tier !== "live");

  const attentionCount = attentionAgents.length;
  const liveCount = liveAgents.length;
  const reviewingCount = backgroundAgents.filter((i) => i.workspaceSummary?.main?.status === "reviewing").length;
  const idleCount = backgroundAgents.filter((i) => i.workspaceSummary?.main?.status === "idle").length;

  const featuredCount = Math.max(attentionAgents.length, liveAgents.length);
  const featuredMinPx = featuredCount <= 2 ? 320 : featuredCount <= 4 ? 280 : 240;
  const compactMinPx = backgroundAgents.length <= 6 ? 220 : backgroundAgents.length <= 12 ? 190 : 165;

  return (
    <div className="flex flex-col gap-0 h-full overflow-y-auto">
      <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 shrink-0 px-4 py-2 border-b border-gray-100 dark:border-gray-800 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm sticky top-0 z-10">
        <span className="font-semibold text-gray-700 dark:text-gray-300">{agents.length} workspace{agents.length !== 1 ? "s" : ""}</span>
        {attentionCount > 0 && (
          <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-semibold">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            {attentionCount} need{attentionCount !== 1 ? "" : "s"} action
          </span>
        )}
        {liveCount > 0 && (
          <span className="flex items-center gap-1 text-green-600 dark:text-green-400 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            {liveCount} running
          </span>
        )}
        {reviewingCount > 0 && (
          <span className="flex items-center gap-1 text-violet-600 dark:text-violet-400">
            <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" />
            {reviewingCount} reviewing
          </span>
        )}
        {idleCount > 0 && (
          <span className="flex items-center gap-1 text-gray-500 dark:text-gray-400">
            <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
            {idleCount} idle
          </span>
        )}
      </div>

      <div className="flex flex-col gap-4 p-4">
        {attentionAgents.length > 0 && (
          <section>
            <h3 className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              Needs Attention
            </h3>
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${featuredMinPx}px, 1fr))` }}
            >
              {attentionAgents.map((issue) => (
                <FeaturedCard
                  key={issue.id}
                  issue={issue}
                  activityHistory={historyRef.current.get(issue.id) ?? []}
                  liveStats={liveStats[issue.id]}
                  todos={sessionTodos[issue.id]}
                  attention={issue.workspaceSummary?.main?.conflicts?.hasConflicts ? "conflict" : "merge"}
                  onIssueClick={onIssueClick}
                  onWorkspaceClick={onWorkspaceClick}
                />
              ))}
            </div>
          </section>
        )}

        {liveAgents.length > 0 && (
          <section>
            <h3 className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              Live
            </h3>
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${featuredMinPx}px, 1fr))` }}
            >
              {liveAgents.map((issue) => (
                <FeaturedCard
                  key={issue.id}
                  issue={issue}
                  activityHistory={historyRef.current.get(issue.id) ?? []}
                  liveStats={liveStats[issue.id]}
                  todos={sessionTodos[issue.id]}
                  onIssueClick={onIssueClick}
                  onWorkspaceClick={onWorkspaceClick}
                />
              ))}
            </div>
          </section>
        )}

        {backgroundAgents.length > 0 && (
          <section>
            <h3 className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
              Background
            </h3>
            <div
              className="grid gap-2"
              style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${compactMinPx}px, 1fr))` }}
            >
              {backgroundAgents.map((issue) => (
                <CompactCard
                  key={issue.id}
                  issue={issue}
                  currentActivity={liveActivity[issue.id]}
                  liveStats={liveStats[issue.id]}
                  todos={sessionTodos[issue.id]}
                  onIssueClick={onIssueClick}
                  onWorkspaceClick={onWorkspaceClick}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
