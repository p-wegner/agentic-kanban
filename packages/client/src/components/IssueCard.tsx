import { useState } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import type { LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const priorityColors: Record<string, string> = {
  low: "bg-gray-200 text-gray-700",
  medium: "bg-blue-100 text-blue-700",
  high: "bg-orange-100 text-orange-700",
  critical: "bg-red-100 text-red-700",
};

interface TagBadge {
  id: string;
  name: string;
  color: string | null;
}

interface IssueCardProps {
  issue: IssueWithStatus;
  onClick: (issue: IssueWithStatus) => void;
  onWorkspaceClick?: (issue: IssueWithStatus, workspaceId?: string) => void;
  onStartWorkspace?: (issue: IssueWithStatus) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  tags?: TagBadge[];
  searchQuery?: string;
  liveActivity?: string;
  liveStats?: LiveSessionStats;
  todos?: TodoItem[];
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return <>{text}</>;

  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);

  return (
    <>
      {before}
      <mark className="bg-yellow-200 rounded px-0.5">{match}</mark>
      {after}
    </>
  );
}

export function IssueCard({ issue, onClick, onWorkspaceClick, onStartWorkspace, onDragStart, tags, searchQuery, liveActivity, liveStats, todos }: IssueCardProps) {
  const badgeColor = priorityColors[issue.priority] ?? "bg-gray-200 text-gray-700";
  const ws = issue.workspaceSummary;
  const hasActiveWorkspace = ws?.main && ws.main.status !== "closed";
  const [depDragOver, setDepDragOver] = useState(false);

  function handleDragOver(e: React.DragEvent) {
    const dragData = (window as unknown as Record<string, unknown>).__dragData as { issueId?: string; sourceStatusId?: string } | undefined;
    if (dragData?.issueId && dragData.issueId !== issue.id && e.shiftKey) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "link";
      setDepDragOver(true);
    }
  }

  async function handleDrop(e: React.DragEvent) {
    setDepDragOver(false);
    if (!e.shiftKey) return;
    const dragData = (window as unknown as Record<string, unknown>).__dragData as { issueId?: string } | undefined;
    if (!dragData?.issueId || dragData.issueId === issue.id) return;
    e.stopPropagation();
    try {
      await apiFetch(`/api/issues/${dragData.issueId}/dependencies`, {
        method: "POST",
        body: JSON.stringify({ dependsOnId: issue.id, type: "depends_on" }),
      });
      showToast("Dependency added", "success");
    } catch {
      showToast("Failed to add dependency", "error");
    }
  }

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, issue)}
      onDragOver={handleDragOver}
      onDragLeave={() => setDepDragOver(false)}
      onDrop={handleDrop}
      onClick={() => onClick(issue)}
      className={`group bg-white rounded-md shadow-sm p-2 border cursor-pointer hover:shadow-md transition-shadow relative ${depDragOver ? "border-purple-400 bg-purple-50 shadow-purple-200" : "border-gray-200 hover:border-gray-300"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-gray-900">
          {issue.issueNumber != null && (
            <span className="text-gray-400 font-mono mr-1">#{issue.issueNumber}</span>
          )}
          <HighlightedText text={issue.title} query={searchQuery ?? ""} />
        </p>
      </div>
      {issue.description && (
        <p className="text-xs text-gray-500 mt-1 line-clamp-2">
          <HighlightedText text={issue.description} query={searchQuery ?? ""} />
        </p>
      )}
      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
        {issue.isBlocked && (
          <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16"><path d="M8 1a2 2 0 0 1 2 2v4H6V3a2 2 0 0 1 2-2zm3 6V3a3 3 0 0 0-6 0v4a2 2 0 0 0 2 2v2.5a.5.5 0 0 0 1 0V9a2 2 0 0 0 2-2z"/></svg>
            blocked
          </span>
        )}
        <span
          className={`inline-block text-xs font-medium px-1.5 py-0.5 rounded ${badgeColor}`}
        >
          {issue.priority}
        </span>
        {tags?.map((tag) => (
          <span
            key={tag.id}
            className="inline-block text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600"
            style={tag.color ? { backgroundColor: tag.color + "22", color: tag.color } : undefined}
          >
            {tag.name}
          </span>
        ))}
      </div>
      {ws && ws.main && (
        <div
          className={`flex items-center gap-1.5 mt-1.5 text-xs cursor-pointer rounded px-1 py-0.5 -mx-1 transition-colors ${
            ws.main.status === "reviewing" ? "bg-purple-50 hover:bg-purple-100" : "hover:bg-gray-50"
          }`}
          title={`Workspace: ${ws.main.branch} (${ws.main.status})`}
          onClick={(e) => { e.stopPropagation(); onWorkspaceClick?.(issue, ws.main?.id); }}
        >
          {ws.main.status === "reviewing" ? (
            <>
              <span className="inline-block w-2 h-2 rounded-full shrink-0 bg-purple-500 animate-pulse" />
              <span className="font-medium text-purple-700">AI Reviewing</span>
            </>
          ) : (
            <>
              <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                ws.main.status === "active" ? "bg-green-500" :
                ws.main.status === "idle" ? "bg-amber-500" :
                "bg-gray-400"
              }`} />
              <span className="font-mono text-gray-600 truncate">{ws.main.branch}</span>
            </>
          )}
          {ws.main.status === "closed" && (
            <span className="text-green-600 font-medium shrink-0">merged</span>
          )}
          <span className="inline-flex items-center gap-1 text-[10px] font-mono shrink-0 ml-auto">
            {ws.main.diffStats && (
              <>
                <span className="text-green-600">+{ws.main.diffStats.insertions}</span>
                <span className="text-red-500">-{ws.main.diffStats.deletions}</span>
                <span className="text-gray-400">{ws.main.diffStats.filesChanged}f</span>
              </>
            )}
            {ws.main.lastSessionAt && ws.main.status !== "active" && ws.main.status !== "reviewing" && (
              <span className="text-gray-400">{ws.main.diffStats ? "· " : ""}{relativeTime(ws.main.lastSessionAt)}</span>
            )}
          </span>
          {ws.main.conflicts?.hasConflicts && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-medium shrink-0">
              {ws.main.conflicts.conflictingFiles.length} conflict{ws.main.conflicts.conflictingFiles.length !== 1 ? "s" : ""}
            </span>
          )}
          {ws.main.claudeProfile && (
            <span className="inline-flex items-center px-1 rounded bg-indigo-50 text-indigo-600 font-medium shrink-0">{ws.main.claudeProfile}</span>
          )}
          {!ws.main.claudeProfile && ws.main.agentCommand && ws.main.agentCommand !== "claude" && (
            <span className="inline-flex items-center px-1 rounded bg-gray-100 text-gray-500 font-mono text-[10px] shrink-0">{ws.main.agentCommand}</span>
          )}
          {ws.total > 1 && (
            <span className="text-gray-400 shrink-0">+{ws.total - 1} more</span>
          )}
        </div>
      )}
      {liveActivity && (
        <div className="flex items-center gap-1.5 mt-1 text-xs text-gray-400 px-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse shrink-0" />
          <span className="truncate">{liveActivity}</span>
        </div>
      )}
      {liveStats && (ws?.total === 1) && (
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-gray-400 px-1">
          {liveStats.model && <span className="font-mono">{liveStats.model}</span>}
          {liveStats.contextTokens > 0 && (
            <span>{Math.round(liveStats.contextTokens / 1000)}k ctx</span>
          )}
          {liveStats.toolUses > 0 && liveStats.contextTokens === 0 && (
            <span>{liveStats.toolUses} tools</span>
          )}
          {liveStats.subagentCount > 0 && (
            <span className="inline-flex items-center gap-0.5 px-1 rounded bg-violet-50 text-violet-600 font-medium">
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              {liveStats.subagentCount}
            </span>
          )}
        </div>
      )}
      {todos && todos.length > 0 && <TodoProgress todos={todos} />}
      {!hasActiveWorkspace && onStartWorkspace && (
        <button
          onClick={(e) => { e.stopPropagation(); onStartWorkspace(issue); }}
          className="mt-1.5 w-full flex items-center justify-center gap-1 text-xs text-blue-600 hover:text-white hover:bg-blue-600 border border-blue-200 hover:border-blue-600 rounded px-2 py-1 transition-colors opacity-0 group-hover:opacity-100"
          title="Start a new workspace for this issue"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          Start Workspace
        </button>
      )}
    </div>
  );
}

function TodoProgress({ todos }: { todos: TodoItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const total = todos.length;
  const completed = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.filter((t) => t.status === "in_progress").length;

  return (
    <div className="mt-1.5 px-1">
      <button
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        className="w-full text-left"
      >
        <div className="flex items-center gap-1.5 mb-0.5">
          <svg
            className={`w-2.5 h-2.5 text-gray-400 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="currentColor" viewBox="0 0 16 16"
          >
            <path d="M6 12l4-4-4-4v8z" />
          </svg>
          <span className="text-[10px] text-gray-400">{completed}/{total} tasks</span>
          {inProgress > 0 && (
            <span className="text-[10px] text-blue-500 font-medium">{inProgress} active</span>
          )}
        </div>
      </button>
      <div className="h-1 bg-gray-200 rounded-full overflow-hidden flex ml-3">
        <div
          className="h-full bg-green-500 transition-all duration-300"
          style={{ width: `${(completed / total) * 100}%` }}
        />
        <div
          className="h-full bg-blue-400 transition-all duration-300"
          style={{ width: `${(inProgress / total) * 100}%` }}
        />
      </div>
      {expanded && (
        <div className="mt-1 ml-3 space-y-0.5">
          {todos.map((t, i) => (
            <div key={i} className="flex items-start gap-1 text-[10px]">
              <span className="shrink-0 mt-0.5">
                {t.status === "completed" ? (
                  <svg className="w-2.5 h-2.5 text-green-500" fill="currentColor" viewBox="0 0 16 16"><path d="M13.854 3.646a.5.5 0 010 .708l-7 7a.5.5 0 01-.708 0l-3.5-3.5a.5.5 0 11.708-.708L6.5 10.293l6.646-6.647a.5.5 0 01.708 0z"/></svg>
                ) : t.status === "in_progress" ? (
                  <svg className="w-2.5 h-2.5 text-blue-500" fill="currentColor" viewBox="0 0 16 16"><path d="M8 1a2 2 0 012 2v4H6V3a2 2 0 012-2zm3 6V3a3 3 0 00-6 0v4a2 2 0 002 2v2.5a.5.5 0 001 0V9a2 2 0 002-2z"/></svg>
                ) : (
                  <svg className="w-2.5 h-2.5 text-gray-300" fill="currentColor" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>
                )}
              </span>
              <span className={t.status === "completed" ? "text-gray-400 line-through" : "text-gray-600"}>
                {t.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
