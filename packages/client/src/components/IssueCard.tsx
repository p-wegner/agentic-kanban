import type { IssueWithStatus } from "@agentic-kanban/shared";

const priorityColors: Record<string, string> = {
  low: "bg-gray-200 text-gray-700",
  medium: "bg-blue-100 text-blue-700",
  high: "bg-orange-100 text-orange-700",
  critical: "bg-red-100 text-red-700",
};

interface IssueCardProps {
  issue: IssueWithStatus;
  onClick: (issue: IssueWithStatus) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
}

export function IssueCard({ issue, onClick, onDragStart }: IssueCardProps) {
  const badgeColor = priorityColors[issue.priority] ?? "bg-gray-200 text-gray-700";

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, issue)}
      onClick={() => onClick(issue)}
      className="bg-white rounded-md shadow-sm p-3 border border-gray-200 cursor-pointer hover:shadow-md hover:border-gray-300 transition-shadow"
    >
      <p className="text-sm text-gray-900">{issue.title}</p>
      {issue.description && (
        <p className="text-xs text-gray-500 mt-1 line-clamp-2">
          {issue.description}
        </p>
      )}
      <span
        className={`inline-block text-xs font-medium px-1.5 py-0.5 rounded mt-1.5 ${badgeColor}`}
      >
        {issue.priority}
      </span>
    </div>
  );
}
