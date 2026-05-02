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
}

export function IssueCard({ issue, onClick, onDragStart, tags }: IssueCardProps) {
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
        <p className="text-sm text-gray-900">{issue.title}</p>
      </div>
      {issue.description && (
        <p className="text-xs text-gray-500 mt-1 line-clamp-2">
          {issue.description}
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
            className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600"
            title={ws.active > 0 ? `${ws.active} active, ${ws.idle} idle` : `${ws.idle} idle`}
          >
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                ws.active > 0
                  ? "bg-green-500 animate-pulse"
                  : "bg-gray-400"
              }`}
            />
            {ws.total}
          </span>
        )}
      </div>
    </div>
  );
}
