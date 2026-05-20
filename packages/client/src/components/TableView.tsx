import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";

interface TableViewProps {
  columns: StatusWithIssues[];
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery: string;
}

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const PRIORITY_COLORS: Record<string, string> = {
  critical: "bg-red-100 text-red-700",
  high: "bg-orange-100 text-orange-700",
  medium: "bg-yellow-100 text-yellow-700",
  low: "bg-gray-100 text-gray-600",
};

export function TableView({ columns, onIssueClick, searchQuery }: TableViewProps) {
  const allIssues = columns.flatMap((col) => col.issues);

  const filtered = searchQuery
    ? allIssues.filter(
        (i) =>
          i.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          i.description?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : allIssues;

  const sorted = [...filtered].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority ?? "low"] ?? 99;
    const pb = PRIORITY_ORDER[b.priority ?? "low"] ?? 99;
    if (pa !== pb) return pa - pb;
    return (a.issueNumber ?? 0) - (b.issueNumber ?? 0);
  });

  if (sorted.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        No issues found
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto px-4 pb-4">
      <table className="w-full text-sm border-collapse">
        <thead className="sticky top-0 bg-gray-50 z-10">
          <tr className="border-b border-gray-200">
            <th className="text-left py-2 px-3 font-medium text-gray-500 w-16">#</th>
            <th className="text-left py-2 px-3 font-medium text-gray-500">Title</th>
            <th className="text-left py-2 px-3 font-medium text-gray-500 w-28">Status</th>
            <th className="text-left py-2 px-3 font-medium text-gray-500 w-24">Priority</th>
            <th className="text-left py-2 px-3 font-medium text-gray-500 w-24">Estimate</th>
            <th className="text-left py-2 px-3 font-medium text-gray-500 w-32">Created</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((issue) => (
            <tr
              key={issue.id}
              onClick={() => onIssueClick(issue)}
              className="border-b border-gray-100 hover:bg-blue-50 cursor-pointer transition-colors"
            >
              <td className="py-2 px-3 text-gray-400 font-mono text-xs">
                #{issue.issueNumber ?? "—"}
              </td>
              <td className="py-2 px-3 font-medium text-gray-800 max-w-xs">
                <span className="line-clamp-1">{issue.title}</span>
                {issue.description && (
                  <span className="block text-xs text-gray-400 font-normal line-clamp-1">
                    {issue.description}
                  </span>
                )}
              </td>
              <td className="py-2 px-3 text-gray-600">
                <span className="text-xs">{issue.statusName}</span>
              </td>
              <td className="py-2 px-3">
                {issue.priority ? (
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${PRIORITY_COLORS[issue.priority] ?? "bg-gray-100 text-gray-600"}`}
                  >
                    {issue.priority}
                  </span>
                ) : (
                  <span className="text-gray-300 text-xs">—</span>
                )}
              </td>
              <td className="py-2 px-3">
                {issue.estimate ? (
                  <span className="text-xs text-gray-600">{issue.estimate}</span>
                ) : (
                  <span className="text-gray-300 text-xs">—</span>
                )}
              </td>
              <td className="py-2 px-3 text-gray-400 text-xs">
                {issue.createdAt
                  ? new Date(issue.createdAt).toLocaleDateString()
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
