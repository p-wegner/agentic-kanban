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
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  tags?: TagBadge[];
  searchQuery?: string;
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

export function IssueCard({ issue, onClick, onDragStart, tags, searchQuery }: IssueCardProps) {
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
        {ws && ws.total > 0 && (
          <span
            className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded"
            title={
              ws.active > 0
                ? `${ws.active} active, ${ws.idle} idle, ${ws.closed} merged`
                : ws.closed > 0 && ws.idle === 0
                  ? `Merged`
                  : `${ws.idle} unmerged, ${ws.closed} merged`
            }
            style={
              ws.closed > 0 && ws.active === 0 && ws.idle === 0
                ? { backgroundColor: "#dcfce722", color: "#16a34a" }
                : ws.idle > 0 && ws.active === 0
                  ? { backgroundColor: "#fef3c722", color: "#d97706" }
                  : undefined
            }
          >
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                ws.active > 0
                  ? "bg-green-500 animate-pulse"
                  : ws.closed > 0 && ws.idle === 0
                    ? "bg-green-500"
                    : ws.idle > 0
                      ? "bg-amber-500"
                      : "bg-gray-400"
              }`}
            />
            {ws.closed > 0 && ws.active === 0 && ws.idle === 0 ? "merged" : ws.total}
          </span>
        )}
      </div>
    </div>
  );
}
