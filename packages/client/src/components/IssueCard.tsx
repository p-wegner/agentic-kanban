import type { IssueWithStatus } from "@agentic-kanban/shared";

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

export function IssueCard({ issue, onClick, onWorkspaceClick, onDragStart, tags, searchQuery, liveActivity }: IssueCardProps) {
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
          className="flex items-center gap-1.5 mt-1.5 text-xs cursor-pointer rounded px-1 py-0.5 -mx-1 hover:bg-gray-50 transition-colors"
          title={`Workspace: ${ws.main.branch} (${ws.main.status})`}
          onClick={(e) => { e.stopPropagation(); onWorkspaceClick?.(issue, ws.main?.id); }}
        >
          <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${
            ws.main.status === "active" ? "bg-green-500" :
            ws.main.status === "idle" ? "bg-amber-500" :
            "bg-gray-400"
          }`} />
          <span className="font-mono text-gray-600 truncate">{ws.main.branch}</span>
          {ws.main.status === "closed" && (
            <span className="text-green-600 font-medium shrink-0">merged</span>
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
    </div>
  );
}
