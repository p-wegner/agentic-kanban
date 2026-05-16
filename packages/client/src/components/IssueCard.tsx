import type { IssueWithStatus } from "@agentic-kanban/shared";
import type { LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";

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

export function IssueCard({ issue, onClick, onWorkspaceClick, onDragStart, tags, searchQuery, liveActivity, liveStats, todos }: IssueCardProps) {
  const badgeColor = priorityColors[issue.priority] ?? "bg-gray-200 text-gray-700";
  const ws = issue.workspaceSummary;

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, issue)}
      onClick={() => onClick(issue)}
      className="bg-white rounded-md shadow-sm p-3 border border-gray-200 cursor-pointer hover:shadow-md hover:border-gray-300 transition-shadow"
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
      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
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
          {ws.main.diffStats && (
            <span className="inline-flex items-center gap-1 text-[10px] font-mono shrink-0 ml-auto">
              <span className="text-green-600">+{ws.main.diffStats.insertions}</span>
              <span className="text-red-500">-{ws.main.diffStats.deletions}</span>
              <span className="text-gray-400">· {ws.main.diffStats.filesChanged}f</span>
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
          {liveStats.contextTokens > 0 ? (
            <span>{Math.round(liveStats.contextTokens / 1000)}k ctx</span>
          ) : liveStats.toolUses > 0 ? (
            <span>{liveStats.toolUses} tools</span>
          ) : null}
        </div>
      )}
      {todos && todos.length > 0 && <TodoProgress todos={todos} />}
    </div>
  );
}

function TodoProgress({ todos }: { todos: TodoItem[] }) {
  const total = todos.length;
  const completed = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.filter((t) => t.status === "in_progress").length;

  return (
    <div className="mt-1.5 px-1" title={todos.map((t) => `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "▶" : "○"} ${t.content}`).join("\n")}>
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="text-[10px] text-gray-400">{completed}/{total} tasks</span>
        {inProgress > 0 && (
          <span className="text-[10px] text-blue-500 font-medium">{inProgress} active</span>
        )}
      </div>
      <div className="h-1 bg-gray-200 rounded-full overflow-hidden flex">
        <div
          className="h-full bg-green-500 transition-all duration-300"
          style={{ width: `${(completed / total) * 100}%` }}
        />
        <div
          className="h-full bg-blue-400 transition-all duration-300"
          style={{ width: `${(inProgress / total) * 100}%` }}
        />
      </div>
    </div>
  );
}
