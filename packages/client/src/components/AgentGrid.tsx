import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import type { LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";
import { getBoardDragData } from "../lib/dragData.js";
import {
  STARTABLE_STATUS_NAMES,
  MAX_HISTORY,
  formatDuration,
  formatTokens,
  resolveCardConfig,
  summarizeTodos,
  resolveContextTokens,
  buildDisplayHistory,
  resolveActivityText,
  selectVisibleAgents,
  partitionAgents,
  computeAgentCounts,
  computeEmptySlotCount,
  computeGridSizing,
  type AttentionKind,
} from "../lib/agentGridView.js";

function ElapsedTimer({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span>{formatDuration(now - new Date(since).getTime())}</span>;
}

// --- Featured card (active / fixing) ----------------------------------------

interface FeaturedCardProps {
  issue: IssueWithStatus;
  activityHistory: string[];
  liveStats?: LiveSessionStats;
  todos?: TodoItem[];
  attention?: AttentionKind;
  onIssueClick: (issue: IssueWithStatus) => void;
  onWorkspaceClick: (issue: IssueWithStatus, workspaceId?: string) => void;
}

function ActivityFeed({ feedRef, lines, dot }: { feedRef: React.RefObject<HTMLDivElement | null>; lines: string[]; dot: string }) {
  return (
    <div
      ref={feedRef}
      className="px-3 py-2 flex-1 overflow-y-auto min-h-[5rem] max-h-32 bg-gray-50 dark:bg-gray-950/50 font-mono"
      style={{ scrollbarWidth: "thin" } as React.CSSProperties}
    >
      {lines.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {lines.map((line, i) => (
            <p
              key={i}
              className={`text-xs leading-relaxed ${i === lines.length - 1 ? "text-gray-800 dark:text-gray-200" : "text-gray-400 dark:text-gray-600"}`}
            >
              {i === lines.length - 1 && (
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot} mr-1.5 mb-0.5 align-middle`} />
              )}
              {line}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-300 dark:text-gray-600 italic">Waiting for activity...</p>
      )}
    </div>
  );
}

function TodoBanner({ inProgress, pending }: { inProgress: TodoItem | undefined; pending: TodoItem[] }) {
  if (inProgress) {
    return (
      <div className="px-3 pt-1.5 pb-0">
        <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 rounded px-2 py-1">
          <svg className="w-3 h-3 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
          </svg>
          <span className="truncate">{inProgress.content}</span>
        </div>
      </div>
    );
  }
  if (pending.length > 0) {
    return (
      <div className="px-3 pt-1.5 pb-0">
        <p className="text-xs text-gray-400 dark:text-gray-500 truncate">Next: {pending[0].content}</p>
      </div>
    );
  }
  return null;
}

function FeaturedFooterStats({
  tokens, toolUses, diff, doneTodos, totalTodos, subagentCount,
}: {
  tokens: number;
  toolUses: number | undefined;
  diff: { filesChanged: number; insertions: number; deletions: number } | null | undefined;
  doneTodos: number;
  totalTodos: number;
  subagentCount: number | null | undefined;
}) {
  return (
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
            <span className="block h-full bg-green-500 dark:bg-green-400 rounded-full transition-all" style={{ width: `${(doneTodos / totalTodos) * 100}%` }} />
          </span>
        </span>
      )}
      {subagentCount != null && subagentCount > 0 && (
        <span className="flex items-center gap-1" title="Subagents">
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="9" cy="7" r="4" /><path d="M3 21v-2a4 4 0 0 1 4-4h4" /><circle cx="17" cy="17" r="3" /><path d="M17 14v6M14 17h6" /></svg>
          {subagentCount}
        </span>
      )}
    </div>
  );
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

  const cfg = resolveCardConfig(ws.status, attention);
  const { done: doneTodos, total: totalTodos, inProgress: inProgressTodo, pending: pendingTodos } = summarizeTodos(todos);
  const tokens = resolveContextTokens(liveStats, ws);
  const displayHistory = buildDisplayHistory(activityHistory, ws);

  return (
    <div className={`flex flex-col bg-surface-raised dark:bg-surface-raised-dark rounded-xl border border-gray-200 dark:border-gray-700 ring-2 ${cfg.ring} overflow-hidden shadow-sm hover:shadow-md transition-shadow`}>
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
            className="text-sm font-semibold text-ink dark:text-stone-100 hover:text-brand-600 dark:hover:text-brand-400 text-left line-clamp-2 leading-snug w-full"
          >
            {issue.title}
          </button>
        </div>
        <button
          onClick={() => onWorkspaceClick(issue, ws.id)}
          className="shrink-0 p-1 rounded text-gray-400 dark:text-gray-500 hover:text-brand-500 hover:bg-brand-50 dark:hover:bg-brand-950 transition-colors"
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

      <ActivityFeed feedRef={feedRef} lines={displayHistory} dot={cfg.dot} />

      <TodoBanner inProgress={inProgressTodo} pending={pendingTodos} />

      <FeaturedFooterStats
        tokens={tokens}
        toolUses={liveStats?.toolUses}
        diff={ws.diffStats}
        doneTodos={doneTodos}
        totalTodos={totalTodos}
        subagentCount={liveStats?.subagentCount}
      />
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

function CompactFooterStats({
  tokens, diff, doneTodos, totalTodos, readyForMerge,
}: {
  tokens: number;
  diff: { insertions: number; deletions: number } | null | undefined;
  doneTodos: number;
  totalTodos: number;
  readyForMerge: boolean | undefined;
}) {
  return (
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
      {readyForMerge && (
        <span className="ml-auto flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium" title="Ready to merge">
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path d="M20 6L9 17l-5-5" /></svg>
          Merge
        </span>
      )}
    </div>
  );
}

function CompactCard({ issue, currentActivity, liveStats, todos, onIssueClick, onWorkspaceClick }: CompactCardProps) {
  const ws = issue.workspaceSummary?.main;
  if (!ws) return null;

  const cfg = resolveCardConfig(ws.status);
  const { done: doneTodos, total: totalTodos } = summarizeTodos(todos);
  const tokens = resolveContextTokens(liveStats, ws);
  const activityText = resolveActivityText(currentActivity, ws);

  return (
    <div
      className={`flex flex-col bg-surface-raised dark:bg-surface-raised-dark rounded-lg border border-gray-200 dark:border-gray-700 ring-1 ${cfg.ring} overflow-hidden shadow-sm hover:shadow-md transition-shadow cursor-pointer`}
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
          className="shrink-0 p-0.5 rounded text-gray-300 dark:text-gray-600 hover:text-brand-500 hover:bg-brand-50 dark:hover:bg-brand-950 transition-colors"
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

      <CompactFooterStats
        tokens={tokens}
        diff={ws.diffStats}
        doneTodos={doneTodos}
        totalTodos={totalTodos}
        readyForMerge={ws.readyForMerge}
      />
    </div>
  );
}

// --- Empty agent slot (drop target) ------------------------------------------

interface EmptySlotProps {
  onDropIssue: (issue: IssueWithStatus) => void;
  columns: StatusWithIssues[];
}

function EmptySlot({ onDropIssue, columns }: EmptySlotProps) {
  const [isDragOver, setIsDragOver] = useState(false);

  function getDraggedIssue(): IssueWithStatus | null {
    const data = getBoardDragData();
    if (!data) return null;
    const allIssues = columns.flatMap((col) => col.issues);
    return allIssues.find((i) => i.id === data.issueId) ?? null;
  }

  function isStartable(issue: IssueWithStatus | null): boolean {
    if (!issue) return false;
    const col = columns.find((c) => c.id === issue.statusId);
    return col ? STARTABLE_STATUS_NAMES.has(col.name) : false;
  }

  function handleDragOver(e: React.DragEvent) {
    const issue = getDraggedIssue();
    if (!isStartable(issue)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsDragOver(true);
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    const issue = getDraggedIssue();
    if (!isStartable(issue)) return;
    onDropIssue(issue!);
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed transition-colors min-h-[10rem] ${
        isDragOver
          ? "border-brand-400 bg-brand-50 dark:border-brand-500 dark:bg-brand-950/30"
          : "border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/20"
      }`}
    >
      <svg
        className={`w-6 h-6 mb-1.5 transition-colors ${isDragOver ? "text-brand-500" : "text-gray-300 dark:text-gray-600"}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v8M8 12h8" />
      </svg>
      <p className={`text-xs font-medium transition-colors ${isDragOver ? "text-brand-600 dark:text-brand-400" : "text-gray-400 dark:text-gray-500"}`}>
        {isDragOver ? "Drop to start workspace" : "Drop issue here"}
      </p>
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
  onGoToBoard?: () => void;
  activeAgentsTarget?: number;
  onDropIssue?: (issue: IssueWithStatus) => void;
}

function GridHeader({ total, counts, emptySlotCount }: {
  total: number;
  counts: ReturnType<typeof computeAgentCounts>;
  emptySlotCount: number;
}) {
  const { attentionCount, liveCount, reviewingCount, idleCount } = counts;
  return (
    <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 shrink-0 px-4 py-2 border-b border-gray-100 dark:border-gray-800 bg-surface-raised/80 dark:bg-surface-raised-dark/80 backdrop-blur-sm sticky top-0 z-10">
      <span className="font-semibold text-gray-700 dark:text-gray-300">{total} workspace{total !== 1 ? "s" : ""}</span>
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
        <span className="flex items-center gap-1 text-accent-700 dark:text-accent-300">
          <span className="w-1.5 h-1.5 rounded-full bg-accent-500 animate-pulse" />
          {reviewingCount} reviewing
        </span>
      )}
      {idleCount > 0 && (
        <span className="flex items-center gap-1 text-gray-500 dark:text-gray-400">
          <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
          {idleCount} idle
        </span>
      )}
      {emptySlotCount > 0 && (
        <span className="flex items-center gap-1 text-gray-400 dark:text-gray-500 ml-auto">
          <span className="w-1.5 h-1.5 rounded-full bg-gray-300 dark:bg-gray-600 border border-dashed border-gray-400" />
          {emptySlotCount} slot{emptySlotCount !== 1 ? "s" : ""} available
        </span>
      )}
    </div>
  );
}

function EmptyState({ onGoToBoard }: { onGoToBoard?: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center h-full text-gray-400 dark:text-gray-500">
      <div className="text-center">
        <svg className="w-12 h-12 mx-auto mb-3 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <circle cx="12" cy="12" r="10" /><path d="M8 12h.01M12 12h.01M16 12h.01" />
        </svg>
        <p className="text-sm font-medium">No active agents</p>
        <p className="text-xs mt-1 mb-3">Create an issue and start a workspace to see agents here</p>
        {onGoToBoard && (
          <button
            onClick={onGoToBoard}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-brand-600 hover:bg-brand-700 text-white transition-colors"
          >
            Go to Board
          </button>
        )}
      </div>
    </div>
  );
}

export function AgentGrid({ columns, liveActivity, liveStats, sessionTodos, onIssueClick, onWorkspaceClick, onGoToBoard, activeAgentsTarget, onDropIssue }: AgentGridProps) {
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

  const agents = selectVisibleAgents(columns, liveActivity);
  const emptySlotCount = computeEmptySlotCount(agents, activeAgentsTarget, Boolean(onDropIssue));

  if (agents.length === 0 && emptySlotCount === 0) {
    return <EmptyState onGoToBoard={onGoToBoard} />;
  }

  const partition = partitionAgents(agents);
  const counts = computeAgentCounts(partition);
  const { featuredMinPx, compactMinPx } = computeGridSizing(partition, emptySlotCount);
  const { attention: attentionAgents, live: liveAgents, background: backgroundAgents } = partition;
  const showLiveSection = liveAgents.length > 0 || emptySlotCount > 0;

  return (
    <div className="flex flex-col gap-0 h-full overflow-y-auto">
      <GridHeader total={agents.length} counts={counts} emptySlotCount={emptySlotCount} />

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

        {showLiveSection && (
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
              {onDropIssue && Array.from({ length: emptySlotCount }, (_, i) => (
                <EmptySlot key={`slot-${i}`} onDropIssue={onDropIssue} columns={columns} />
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
