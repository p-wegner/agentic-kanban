import { useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";

interface TableViewProps {
  columns: StatusWithIssues[];
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery?: string;
}

const ISSUE_TYPE_LABEL: Record<string, string> = {
  task: "Task",
  bug: "Bug",
  feature: "Feature",
  chore: "Chore",
};

const ISSUE_TYPE_CLASS: Record<string, string> = {
  task: "text-gray-600 bg-gray-100",
  bug: "text-red-700 bg-red-50",
  feature: "text-blue-700 bg-blue-50",
  chore: "text-amber-700 bg-amber-50",
};

const STATUS_CLASS: Record<string, string> = {
  "Todo": "text-gray-600 bg-gray-100",
  "In Progress": "text-blue-700 bg-blue-50",
  "In Review": "text-purple-700 bg-purple-50",
  "AI Reviewed": "text-indigo-700 bg-indigo-50",
  "Done": "text-green-700 bg-green-50",
  "Cancelled": "text-gray-500 bg-gray-100",
};

const ARCHIVE_STATUSES = new Set(["Done", "Cancelled"]);

type SortKey = "number" | "title" | "status" | "priority" | "type" | "estimate" | "updated" | "dueDate";
type SortDir = "asc" | "desc";

const ISSUE_TYPE_ORDER: Record<string, number> = { bug: 0, feature: 1, task: 2, chore: 3 };
const ESTIMATE_ORDER: Record<string, number> = { XS: 0, S: 1, M: 2, L: 3, XL: 4 };
const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const PRIORITY_LABEL: Record<string, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };
const PRIORITY_CLASS: Record<string, string> = {
  urgent: "text-red-700 bg-red-50",
  high: "text-orange-700 bg-orange-50",
  medium: "text-yellow-700 bg-yellow-50",
  low: "text-gray-500 bg-gray-100",
};

const TAG_COLORS: Record<string, string> = {
  blue: "bg-blue-100 text-blue-700",
  green: "bg-green-100 text-green-700",
  red: "bg-red-100 text-red-700",
  yellow: "bg-yellow-100 text-yellow-700",
  purple: "bg-purple-100 text-purple-700",
  pink: "bg-pink-100 text-pink-700",
  orange: "bg-orange-100 text-orange-700",
  indigo: "bg-indigo-100 text-indigo-700",
  gray: "bg-gray-100 text-gray-600",
};

function tagClass(color: string | null | undefined) {
  return TAG_COLORS[color ?? ""] ?? "bg-gray-100 text-gray-600";
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function TableView({ columns, onIssueClick, searchQuery }: TableViewProps) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "number", dir: "asc" });
  const [statusFilter, setStatusFilter] = useState<string>("active");

  const allIssues = columns.flatMap((col) =>
    col.issues.map((issue) => ({ ...issue, statusName: col.name }))
  );

  const q = searchQuery?.toLowerCase() ?? "";
  const filtered = allIssues.filter((issue) => {
    if (statusFilter === "active" && ARCHIVE_STATUSES.has(issue.statusName)) return false;
    if (statusFilter !== "active" && statusFilter !== "all" && issue.statusName !== statusFilter) return false;
    if (q) return issue.title.toLowerCase().includes(q) || (issue.description ?? "").toLowerCase().includes(q);
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    switch (sort.key) {
      case "number": cmp = (a.issueNumber ?? 0) - (b.issueNumber ?? 0); break;
      case "title": cmp = a.title.localeCompare(b.title); break;
      case "status": cmp = a.statusName.localeCompare(b.statusName); break;
      case "priority": cmp = (PRIORITY_ORDER[a.priority ?? "medium"] ?? 2) - (PRIORITY_ORDER[b.priority ?? "medium"] ?? 2); break;
      case "type": cmp = (ISSUE_TYPE_ORDER[a.issueType ?? "task"] ?? 2) - (ISSUE_TYPE_ORDER[b.issueType ?? "task"] ?? 2); break;
      case "estimate": cmp = (ESTIMATE_ORDER[a.estimate ?? ""] ?? 99) - (ESTIMATE_ORDER[b.estimate ?? ""] ?? 99); break;
      case "updated": cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(); break;
      case "dueDate": {
        const aTime = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
        const bTime = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
        cmp = aTime - bTime;
        break;
      }
    }
    return sort.dir === "asc" ? cmp : -cmp;
  });

  function toggleSort(key: SortKey) {
    setSort((prev) => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }

  function SortIcon({ col }: { col: SortKey }) {
    if (sort.key !== col) return <span className="text-gray-300 dark:text-gray-600 ml-1">↕</span>;
    return <span className="text-blue-500 ml-1">{sort.dir === "asc" ? "↑" : "↓"}</span>;
  }

  const statusNames = [...new Set(columns.map((c) => c.name))];

  return (
    <div className="flex flex-col flex-1 min-h-0 px-4 pb-4">
      <div className="flex items-center gap-3 py-2 mb-2">
        <span className="text-xs text-gray-500 dark:text-gray-400">{sorted.length} issue{sorted.length !== 1 ? "s" : ""}</span>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300"
        >
          <option value="active">Active only</option>
          <option value="all">All statuses</option>
          {statusNames.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="flex-1 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800 z-10">
            <tr>
              {(
                [
                  ["number", "#"],
                  ["title", "Title"],
                  ["status", "Status"],
                  ["priority", "Priority"],
                  ["type", "Type"],
                  ["estimate", "Estimate"],
                  ["updated", "Updated"],
                  ["dueDate", "Due Date"],
                ] as [SortKey, string][]
              ).map(([key, label]) => (
                <th
                  key={key}
                  onClick={() => toggleSort(key)}
                  className="text-left text-xs font-medium text-gray-500 dark:text-gray-400 px-3 py-2 border-b border-gray-200 dark:border-gray-700 cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-200 whitespace-nowrap"
                >
                  {label}<SortIcon col={key} />
                </th>
              ))}
              <th className="text-left text-xs font-medium text-gray-500 dark:text-gray-400 px-3 py-2 border-b border-gray-200 dark:border-gray-700 whitespace-nowrap">
                Tags
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center text-gray-400 dark:text-gray-500 text-sm py-12">No issues found</td>
              </tr>
            )}
            {sorted.map((issue) => (
              <tr
                key={issue.id}
                onClick={() => onIssueClick(issue)}
                className="border-b border-gray-100 dark:border-gray-800 hover:bg-blue-50 dark:hover:bg-blue-900/20 cursor-pointer transition-colors"
              >
                <td className="px-3 py-1.5 text-gray-400 dark:text-gray-500 text-xs whitespace-nowrap">
                  #{issue.issueNumber ?? "—"}
                </td>
                <td className="px-3 py-1.5 max-w-xs">
                  <span className="font-medium text-gray-900 dark:text-gray-100 truncate block">{issue.title}</span>
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap">
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLASS[issue.statusName] ?? "text-gray-600 bg-gray-100"}`}>
                    {issue.statusName}
                  </span>
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap">
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${PRIORITY_CLASS[issue.priority ?? "medium"] ?? PRIORITY_CLASS.medium}`}>
                    {PRIORITY_LABEL[issue.priority ?? "medium"] ?? issue.priority ?? "medium"}
                  </span>
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap">
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${ISSUE_TYPE_CLASS[issue.issueType ?? "task"] ?? ""}`}>
                    {ISSUE_TYPE_LABEL[issue.issueType ?? "task"] ?? issue.issueType ?? "task"}
                  </span>
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap text-xs text-gray-600 dark:text-gray-400">
                  {issue.estimate ?? <span className="text-gray-300 dark:text-gray-600">—</span>}
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
                  {formatDate(issue.updatedAt)}
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap text-xs">
                  {issue.dueDate ? (() => {
                    const overdue = new Date(issue.dueDate) < new Date(new Date().toDateString()) &&
                      issue.statusName !== "Done" && issue.statusName !== "Cancelled";
                    return (
                      <span className={overdue ? "text-red-600 font-medium" : "text-gray-500 dark:text-gray-400"}>
                        {formatDate(issue.dueDate)}
                      </span>
                    );
                  })() : <span className="text-gray-300 dark:text-gray-600">—</span>}
                </td>
                <td className="px-3 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {(issue.tags ?? []).map((tag) => (
                      <span key={tag.id} className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${tagClass(tag.color)}`}>
                        {tag.name}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
