<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
import { useState } from "react";
=======
>>>>>>> 7c9ead0 (feat: add table view as third board view alongside board and graph)
=======
import { useState } from "react";
>>>>>>> e318eb3 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> 770082f (feat: add table view as third board view alongside board and graph)
=======
import { useState } from "react";
>>>>>>> 9878a53 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> b06ea29 (feat: add table view as third board view alongside board and graph)
=======
import { useState } from "react";
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";

interface TableViewProps {
  columns: StatusWithIssues[];
  onIssueClick: (issue: IssueWithStatus) => void;
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> e318eb3 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> 9878a53 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
  searchQuery?: string;
}

const PRIORITY_LABEL: Record<string, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const PRIORITY_CLASS: Record<string, string> = {
  urgent: "text-red-700 bg-red-50",
  high: "text-orange-700 bg-orange-50",
  medium: "text-yellow-700 bg-yellow-50",
  low: "text-gray-600 bg-gray-100",
};

const STATUS_CLASS: Record<string, string> = {
  "Todo": "text-gray-600 bg-gray-100",
  "In Progress": "text-blue-700 bg-blue-50",
  "In Review": "text-purple-700 bg-purple-50",
  "AI Reviewed": "text-indigo-700 bg-indigo-50",
  "Done": "text-green-700 bg-green-50",
  "Cancelled": "text-gray-500 bg-gray-100",
};

<<<<<<< HEAD
const ARCHIVE_STATUSES = new Set(["Done", "Cancelled"]);

type SortKey = "number" | "title" | "status" | "priority" | "estimate" | "updated";
=======
type SortKey = "number" | "title" | "status" | "priority" | "estimate" | "created";
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
type SortDir = "asc" | "desc";

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const ESTIMATE_ORDER: Record<string, number> = { XS: 0, S: 1, M: 2, L: 3, XL: 4 };

<<<<<<< HEAD
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

<<<<<<< HEAD
=======
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> ab01232 (fix: restore TableView.tsx mangled by conflict resolution — use clean version from 4fb96d3)
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function TableView({ columns, onIssueClick, searchQuery }: TableViewProps) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "number", dir: "asc" });
<<<<<<< HEAD
<<<<<<< HEAD
  const [statusFilter, setStatusFilter] = useState<string>("active");
=======
  const [statusFilter, setStatusFilter] = useState<string>("all");
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
=======
  const [statusFilter, setStatusFilter] = useState<string>("active");
>>>>>>> ab01232 (fix: restore TableView.tsx mangled by conflict resolution — use clean version from 4fb96d3)

  const allIssues = columns.flatMap((col) =>
    col.issues.map((issue) => ({ ...issue, statusName: col.name }))
  );

  const q = searchQuery?.toLowerCase() ?? "";
  const filtered = allIssues.filter((issue) => {
<<<<<<< HEAD
    if (statusFilter === "active" && ARCHIVE_STATUSES.has(issue.statusName)) return false;
    if (statusFilter !== "active" && statusFilter !== "all" && issue.statusName !== statusFilter) return false;
=======
    if (statusFilter !== "all" && issue.statusName !== statusFilter) return false;
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
    if (q) return issue.title.toLowerCase().includes(q) || (issue.description ?? "").toLowerCase().includes(q);
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    switch (sort.key) {
      case "number": cmp = (a.issueNumber ?? 0) - (b.issueNumber ?? 0); break;
      case "title": cmp = a.title.localeCompare(b.title); break;
      case "status": cmp = a.statusName.localeCompare(b.statusName); break;
      case "priority": cmp = (PRIORITY_ORDER[a.priority ?? "low"] ?? 3) - (PRIORITY_ORDER[b.priority ?? "low"] ?? 3); break;
      case "estimate": cmp = (ESTIMATE_ORDER[a.estimate ?? ""] ?? 99) - (ESTIMATE_ORDER[b.estimate ?? ""] ?? 99); break;
<<<<<<< HEAD
      case "updated": cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(); break;
=======
      case "created": cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(); break;
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
    }
    return sort.dir === "asc" ? cmp : -cmp;
  });

  function toggleSort(key: SortKey) {
    setSort((prev) => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }

  function SortIcon({ col }: { col: SortKey }) {
    if (sort.key !== col) return <span className="text-gray-300 ml-1">↕</span>;
    return <span className="text-blue-500 ml-1">{sort.dir === "asc" ? "↑" : "↓"}</span>;
  }

  const statusNames = [...new Set(columns.map((c) => c.name))];

  return (
    <div className="flex flex-col flex-1 min-h-0 px-4 pb-4">
      <div className="flex items-center gap-3 py-2 mb-2">
        <span className="text-xs text-gray-500">{sorted.length} issue{sorted.length !== 1 ? "s" : ""}</span>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="text-xs border border-gray-200 rounded px-2 py-1 bg-white text-gray-700"
        >
<<<<<<< HEAD
          <option value="active">Active only</option>
<<<<<<< HEAD
=======
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> ab01232 (fix: restore TableView.tsx mangled by conflict resolution — use clean version from 4fb96d3)
          <option value="all">All statuses</option>
          {statusNames.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="flex-1 overflow-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 bg-gray-50 z-10">
            <tr>
              {(
                [
                  ["number", "#"],
                  ["title", "Title"],
                  ["status", "Status"],
                  ["priority", "Priority"],
                  ["estimate", "Estimate"],
<<<<<<< HEAD
<<<<<<< HEAD
                  ["updated", "Updated"],
=======
                  ["created", "Created"],
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
=======
                  ["updated", "Updated"],
>>>>>>> ab01232 (fix: restore TableView.tsx mangled by conflict resolution — use clean version from 4fb96d3)
                ] as [SortKey, string][]
              ).map(([key, label]) => (
                <th
                  key={key}
                  onClick={() => toggleSort(key)}
                  className="text-left text-xs font-medium text-gray-500 px-3 py-2 border-b border-gray-200 cursor-pointer select-none hover:text-gray-700 whitespace-nowrap"
                >
                  {label}<SortIcon col={key} />
                </th>
              ))}
<<<<<<< HEAD
              <th className="text-left text-xs font-medium text-gray-500 px-3 py-2 border-b border-gray-200 whitespace-nowrap">
                Tags
              </th>
<<<<<<< HEAD
=======
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> ab01232 (fix: restore TableView.tsx mangled by conflict resolution — use clean version from 4fb96d3)
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
<<<<<<< HEAD
<<<<<<< HEAD
                <td colSpan={7} className="text-center text-gray-400 text-sm py-12">No issues found</td>
=======
                <td colSpan={6} className="text-center text-gray-400 text-sm py-12">No issues found</td>
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
=======
                <td colSpan={7} className="text-center text-gray-400 text-sm py-12">No issues found</td>
>>>>>>> ab01232 (fix: restore TableView.tsx mangled by conflict resolution — use clean version from 4fb96d3)
              </tr>
            )}
            {sorted.map((issue) => (
              <tr
                key={issue.id}
                onClick={() => onIssueClick(issue)}
                className="border-b border-gray-100 hover:bg-blue-50 cursor-pointer transition-colors"
              >
<<<<<<< HEAD
                <td className="px-3 py-1.5 text-gray-400 text-xs whitespace-nowrap">
                  #{issue.issueNumber ?? "—"}
                </td>
                <td className="px-3 py-1.5 max-w-xs">
                  <span className="font-medium text-gray-900 truncate block">{issue.title}</span>
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap">
=======
                <td className="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">
                  #{issue.issueNumber ?? "—"}
                </td>
                <td className="px-3 py-2 max-w-xs">
                  <span className="font-medium text-gray-900 line-clamp-1">{issue.title}</span>
                  {issue.description && (
                    <span className="block text-xs text-gray-400 line-clamp-1">{issue.description}</span>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLASS[issue.statusName] ?? "text-gray-600 bg-gray-100"}`}>
                    {issue.statusName}
                  </span>
                </td>
<<<<<<< HEAD
                <td className="px-3 py-1.5 whitespace-nowrap">
=======
                <td className="px-3 py-2 whitespace-nowrap">
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
                  {issue.priority ? (
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${PRIORITY_CLASS[issue.priority] ?? ""}`}>
                      {PRIORITY_LABEL[issue.priority] ?? issue.priority}
                    </span>
                  ) : <span className="text-gray-300">—</span>}
                </td>
<<<<<<< HEAD
                <td className="px-3 py-1.5 whitespace-nowrap text-xs text-gray-600">
                  {issue.estimate ?? <span className="text-gray-300">—</span>}
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap text-xs text-gray-500">
                  {formatDate(issue.updatedAt)}
                </td>
                <td className="px-3 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {(issue.tags ?? []).map((tag) => (
                      <span key={tag.id} className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${tagClass(tag.color)}`}>
                        {tag.name}
                      </span>
                    ))}
                  </div>
=======
                <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-600">
                  {issue.estimate ?? <span className="text-gray-300">—</span>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">
                  {formatDate(issue.createdAt)}
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
=======
>>>>>>> 770082f (feat: add table view as third board view alongside board and graph)
=======
>>>>>>> b06ea29 (feat: add table view as third board view alongside board and graph)
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
<<<<<<< HEAD
<<<<<<< HEAD
>>>>>>> 7c9ead0 (feat: add table view as third board view alongside board and graph)
=======
>>>>>>> e318eb3 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> 770082f (feat: add table view as third board view alongside board and graph)
=======
>>>>>>> 9878a53 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> b06ea29 (feat: add table view as third board view alongside board and graph)
=======
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
    </div>
  );
}
