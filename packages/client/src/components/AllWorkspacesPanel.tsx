<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
import { useState } from "react";
=======
>>>>>>> b4a5c74 (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> ed04713 (feat: add All Workspaces aggregate panel (#101))
=======
import { useState } from "react";
>>>>>>> 1bb4b1b (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> f4516a3 (feat: add All Workspaces aggregate panel (#101))
=======
import { useState } from "react";
>>>>>>> 6b5ede9 (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> e633a5a (feat: add All Workspaces aggregate panel (#101))
=======
import { useState } from "react";
>>>>>>> 8baaf16 (feat: add status filter and text search to All Workspaces panel)
=======
import { useState } from "react";
=======
>>>>>>> b4a5c74 (feat: add All Workspaces aggregate panel (#101))
>>>>>>> 862c38b (feat: add All Workspaces aggregate panel (#101))
=======
import { useState } from "react";
>>>>>>> 2d71bd2 (fix: resolve merge conflict markers by restoring stale files from master)
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { apiFetch } from "../lib/api.js";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";

interface AllWorkspacesPanelProps {
  columns: StatusWithIssues[];
  onClose: () => void;
  onIssueClick: (issue: IssueWithStatus) => void;
  onRefresh?: () => void;
}

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 1bb4b1b (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> 6b5ede9 (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> 8baaf16 (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> 862c38b (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> 2d71bd2 (fix: resolve merge conflict markers by restoring stale files from master)
type WsStatusFilter = "all" | "active" | "running" | "idle" | "reviewing" | "closed";
=======
type WsStatusFilter = "all" | "active" | "running" | "idle" | "reviewing" | "fixing" | "closed";
>>>>>>> 6117824 (feat: show trigger type badges for skills, AI Review, and AI Merge in session history and board cards)

const FILTER_CHIPS: { label: string; value: WsStatusFilter }[] = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Running", value: "running" },
  { label: "Idle", value: "idle" },
  { label: "Reviewing", value: "reviewing" },
  { label: "Fixing", value: "fixing" },
  { label: "Closed", value: "closed" },
];

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> b4a5c74 (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> ed04713 (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> 1bb4b1b (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> f4516a3 (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> 6b5ede9 (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> e633a5a (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> 8baaf16 (feat: add status filter and text search to All Workspaces panel)
=======
=======
>>>>>>> b4a5c74 (feat: add All Workspaces aggregate panel (#101))
>>>>>>> 862c38b (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> 2d71bd2 (fix: resolve merge conflict markers by restoring stale files from master)
const WS_STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  reviewing: "bg-purple-100 text-purple-700",
  fixing: "bg-orange-100 text-orange-700",
  idle: "bg-yellow-100 text-yellow-700",
  closed: "bg-gray-100 text-gray-500",
};

const ISSUE_STATUS_COLORS: Record<string, string> = {
  "Todo": "bg-gray-100 text-gray-600",
  "In Progress": "bg-blue-100 text-blue-700",
  "In Review": "bg-orange-100 text-orange-700",
  "AI Reviewed": "bg-purple-100 text-purple-700",
  "Done": "bg-green-100 text-green-700",
  "Cancelled": "bg-red-100 text-red-500",
};

<<<<<<< HEAD
export function AllWorkspacesPanel({ columns, onClose, onIssueClick }: AllWorkspacesPanelProps) {
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 862c38b (feat: add All Workspaces aggregate panel (#101))
=======
export function AllWorkspacesPanel({ columns, onClose, onIssueClick, onRefresh }: AllWorkspacesPanelProps) {
>>>>>>> f8e9393 (feat: add Close idle workspaces bulk action to All Workspaces panel)
  const [statusFilter, setStatusFilter] = useState<WsStatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [closingIdle, setClosingIdle] = useState(false);

=======
>>>>>>> b4a5c74 (feat: add All Workspaces aggregate panel (#101))
<<<<<<< HEAD
=======
>>>>>>> ed04713 (feat: add All Workspaces aggregate panel (#101))
=======
  const [statusFilter, setStatusFilter] = useState<WsStatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");

>>>>>>> 1bb4b1b (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> f4516a3 (feat: add All Workspaces aggregate panel (#101))
=======
  const [statusFilter, setStatusFilter] = useState<WsStatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");

>>>>>>> 6b5ede9 (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> e633a5a (feat: add All Workspaces aggregate panel (#101))
=======
  const [statusFilter, setStatusFilter] = useState<WsStatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");

>>>>>>> 8baaf16 (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> 862c38b (feat: add All Workspaces aggregate panel (#101))
=======
  const [statusFilter, setStatusFilter] = useState<WsStatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");

>>>>>>> 2d71bd2 (fix: resolve merge conflict markers by restoring stale files from master)
  const issuesWithWorkspaces: IssueWithStatus[] = columns
    .flatMap((col) => col.issues)
    .filter((issue) => issue.workspaceSummary && issue.workspaceSummary.total > 0);

  const activeCount = issuesWithWorkspaces.filter(
    (i) => ["active", "reviewing", "fixing"].includes(i.workspaceSummary?.main?.status ?? "")
  ).length;

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 1bb4b1b (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> 6b5ede9 (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> 8baaf16 (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> 862c38b (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> 2d71bd2 (fix: resolve merge conflict markers by restoring stale files from master)
=======
  const idleWorkspaceIds = issuesWithWorkspaces
    .filter((i) => i.workspaceSummary?.main?.status === "idle")
    .map((i) => i.workspaceSummary!.main!.id);

  async function handleCloseIdle() {
    if (idleWorkspaceIds.length === 0) return;
    const confirmed = window.confirm(
      `Close ${idleWorkspaceIds.length} idle workspace${idleWorkspaceIds.length !== 1 ? "s" : ""}?`
    );
    if (!confirmed) return;
    setClosingIdle(true);
    for (const id of idleWorkspaceIds) {
      try {
        await apiFetch(`/api/workspaces/${id}`, { method: "DELETE" });
      } catch {
        // non-fatal — continue with the rest
      }
      onRefresh?.();
    }
    setClosingIdle(false);
  }

>>>>>>> f8e9393 (feat: add Close idle workspaces bulk action to All Workspaces panel)
  const filtered = issuesWithWorkspaces.filter((issue) => {
    const ws = issue.workspaceSummary!;
    const mainStatus = ws.main?.status ?? "";

    if (statusFilter !== "all") {
      if (statusFilter === "active") {
        if (!["active", "reviewing", "fixing"].includes(mainStatus)) return false;
      } else if (mainStatus !== statusFilter) {
        return false;
      }
    }

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      const matchesTitle = issue.title.toLowerCase().includes(q);
      const matchesBranch = (ws.main?.branch ?? "").toLowerCase().includes(q);
      if (!matchesTitle && !matchesBranch) return false;
    }

    return true;
  });

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> b4a5c74 (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> ed04713 (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> 1bb4b1b (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> f4516a3 (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> 6b5ede9 (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> e633a5a (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> 8baaf16 (feat: add status filter and text search to All Workspaces panel)
=======
=======
>>>>>>> b4a5c74 (feat: add All Workspaces aggregate panel (#101))
>>>>>>> 862c38b (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> 2d71bd2 (fix: resolve merge conflict markers by restoring stale files from master)
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-[min(520px,100vw)] bg-white shadow-xl flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <svg className="h-5 w-5 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            <h2 className="text-lg font-semibold text-gray-900">All Workspaces</h2>
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 1bb4b1b (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> 6b5ede9 (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> 8baaf16 (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> 862c38b (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> 2d71bd2 (fix: resolve merge conflict markers by restoring stale files from master)
            <span className="text-sm text-gray-500">
              {filtered.length === issuesWithWorkspaces.length
                ? `(${issuesWithWorkspaces.length})`
                : `${filtered.length} of ${issuesWithWorkspaces.length}`}
            </span>
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
            <span className="text-sm text-gray-500">({issuesWithWorkspaces.length})</span>
>>>>>>> b4a5c74 (feat: add All Workspaces aggregate panel (#101))
=======
            <span className="text-sm text-gray-500">({issuesWithWorkspaces.length})</span>
>>>>>>> ed04713 (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> 1bb4b1b (feat: add status filter and text search to All Workspaces panel)
=======
            <span className="text-sm text-gray-500">({issuesWithWorkspaces.length})</span>
>>>>>>> f4516a3 (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> 6b5ede9 (feat: add status filter and text search to All Workspaces panel)
=======
            <span className="text-sm text-gray-500">({issuesWithWorkspaces.length})</span>
>>>>>>> e633a5a (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> 8baaf16 (feat: add status filter and text search to All Workspaces panel)
=======
=======
            <span className="text-sm text-gray-500">({issuesWithWorkspaces.length})</span>
>>>>>>> b4a5c74 (feat: add All Workspaces aggregate panel (#101))
>>>>>>> 862c38b (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> 2d71bd2 (fix: resolve merge conflict markers by restoring stale files from master)
            {activeCount > 0 && (
              <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">
                {activeCount} active
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {idleWorkspaceIds.length > 0 && (
              <button
                onClick={handleCloseIdle}
                disabled={closingIdle}
                className="text-xs px-2.5 py-1 rounded bg-yellow-100 text-yellow-700 hover:bg-yellow-200 disabled:opacity-50 font-medium"
              >
                {closingIdle ? "Closing…" : `Close ${idleWorkspaceIds.length} idle`}
              </button>
            )}
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-lg leading-none"
            >
              &times;
            </button>
          </div>
        </div>

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 1bb4b1b (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> 6b5ede9 (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> 8baaf16 (feat: add status filter and text search to All Workspaces panel)
=======
>>>>>>> 862c38b (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> 2d71bd2 (fix: resolve merge conflict markers by restoring stale files from master)
        {/* Filters */}
        <div className="px-4 py-2 border-b border-gray-100 space-y-2">
          {/* Text search */}
          <input
            type="text"
            placeholder="Search by title or branch…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full text-sm px-3 py-1.5 border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          {/* Status chips */}
          <div className="flex gap-1.5 flex-wrap">
            {FILTER_CHIPS.map((chip) => (
              <button
                key={chip.value}
                onClick={() => setStatusFilter(chip.value)}
                className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${
                  statusFilter === chip.value
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {chip.label}
              </button>
            ))}
          </div>
        </div>

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-gray-500">
              {issuesWithWorkspaces.length === 0
                ? "No workspaces yet. Create a workspace from an issue to get started."
                : "No workspaces match the current filter."}
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {filtered.map((issue) => {
<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
>>>>>>> ed04713 (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> 1bb4b1b (feat: add status filter and text search to All Workspaces panel)
        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-gray-500">
              {issuesWithWorkspaces.length === 0
                ? "No workspaces yet. Create a workspace from an issue to get started."
                : "No workspaces match the current filter."}
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
<<<<<<< HEAD
              {issuesWithWorkspaces.map((issue) => {
<<<<<<< HEAD
>>>>>>> b4a5c74 (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> ed04713 (feat: add All Workspaces aggregate panel (#101))
=======
              {filtered.map((issue) => {
>>>>>>> 1bb4b1b (feat: add status filter and text search to All Workspaces panel)
=======
=======
>>>>>>> 6b5ede9 (feat: add status filter and text search to All Workspaces panel)
        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-gray-500">
              {issuesWithWorkspaces.length === 0
                ? "No workspaces yet. Create a workspace from an issue to get started."
                : "No workspaces match the current filter."}
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
<<<<<<< HEAD
              {issuesWithWorkspaces.map((issue) => {
>>>>>>> f4516a3 (feat: add All Workspaces aggregate panel (#101))
=======
              {filtered.map((issue) => {
>>>>>>> 6b5ede9 (feat: add status filter and text search to All Workspaces panel)
=======
=======
>>>>>>> 8baaf16 (feat: add status filter and text search to All Workspaces panel)
        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-gray-500">
              {issuesWithWorkspaces.length === 0
                ? "No workspaces yet. Create a workspace from an issue to get started."
                : "No workspaces match the current filter."}
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
<<<<<<< HEAD
              {issuesWithWorkspaces.map((issue) => {
>>>>>>> e633a5a (feat: add All Workspaces aggregate panel (#101))
=======
              {filtered.map((issue) => {
>>>>>>> 8baaf16 (feat: add status filter and text search to All Workspaces panel)
=======
        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {issuesWithWorkspaces.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-gray-500">
              No workspaces yet. Create a workspace from an issue to get started.
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {issuesWithWorkspaces.map((issue) => {
>>>>>>> b4a5c74 (feat: add All Workspaces aggregate panel (#101))
>>>>>>> 862c38b (feat: add All Workspaces aggregate panel (#101))
=======
>>>>>>> 2d71bd2 (fix: resolve merge conflict markers by restoring stale files from master)
                const ws = issue.workspaceSummary!;
                const main = ws.main;

                return (
                  <div
                    key={issue.id}
                    className="px-4 py-3 hover:bg-gray-50 cursor-pointer"
                    onClick={() => onIssueClick(issue)}
                  >
                    {/* Issue title + status */}
                    <div className="flex items-start gap-2 mb-1.5">
                      <span className="text-xs text-gray-400 font-mono mt-0.5 shrink-0">
                        #{issue.issueNumber}
                      </span>
                      <span className="text-sm font-medium text-gray-900 flex-1 min-w-0 line-clamp-1">
                        {issue.title}
                      </span>
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${ISSUE_STATUS_COLORS[issue.statusName] ?? "bg-gray-100 text-gray-600"}`}
                      >
                        {issue.statusName}
                      </span>
                    </div>

                    {/* Workspace details */}
                    {main && (
                      <div className="flex items-center gap-2 flex-wrap ml-6">
                        {/* Branch */}
                        <span className="text-xs text-gray-500 font-mono truncate max-w-[180px]">
                          {main.branch}
                        </span>

                        {/* Workspace status */}
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded ${WS_STATUS_COLORS[main.status] ?? "bg-gray-100 text-gray-600"}`}
                        >
                          {main.status === "reviewing" ? "AI Reviewing" : main.status === "fixing" ? "AI Fixing" : main.status}
                        </span>

                        {/* Ready to merge */}
                        {main.readyForMerge && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700">
                            Ready to merge
                          </span>
                        )}

                        {/* Diff stats */}
                        {main.diffStats && main.diffStats.filesChanged > 0 && (
                          <span className="text-xs text-gray-500">
                            {main.diffStats.filesChanged} file{main.diffStats.filesChanged !== 1 ? "s" : ""},&nbsp;
                            <span className="text-green-600">+{main.diffStats.insertions}</span>
                            {" / "}
                            <span className="text-red-500">-{main.diffStats.deletions}</span>
                          </span>
                        )}

                        {/* Conflicts */}
                        {main.conflicts?.hasConflicts && (
                          <span className="text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded">
                            {main.conflicts.conflictingFiles.length} conflict{main.conflicts.conflictingFiles.length !== 1 ? "s" : ""}
                          </span>
                        )}

                        {/* Last session trigger */}
                        {main.lastSessionTriggerType && (() => {
                          const map: Record<string, { label: string; className: string }> = {
                            review: { label: "AI Review", className: "bg-violet-100 text-violet-700" },
                            merge: { label: "AI Merge", className: "bg-emerald-100 text-emerald-700" },
                            "fix-conflicts": { label: "Fix Conflicts", className: "bg-orange-100 text-orange-700" },
                            learning: { label: "Learning", className: "bg-teal-100 text-teal-700" },
                            "auto-start": { label: "Auto-start", className: "bg-gray-100 text-gray-600" },
                          };
                          const badge = map[main.lastSessionTriggerType] ?? (main.lastSessionTriggerType.startsWith("skill:") ? { label: main.lastSessionTriggerType.slice(6), className: "bg-purple-100 text-purple-700" } : null);
                          return badge ? <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${badge.className}`}>{badge.label}</span> : null;
                        })()}

                        {/* Last session */}
                        {main.lastSessionAt && (
                          <span className="text-xs text-gray-400">
                            {formatRelativeTime(main.lastSessionAt)}
                          </span>
                        )}

                        {/* Context usage */}
                        {(main.status === "active" || main.status === "fixing") && main.contextTokens ? (
                          <span className="text-xs text-gray-400" title={`${main.contextTokens.toLocaleString()} context tokens`}>
                            {main.contextTokens >= 1000
                              ? `${Math.round(main.contextTokens / 1000)}k ctx`
                              : `${main.contextTokens} ctx`}
                          </span>
                        ) : null}

                        {/* Last tool */}
                        {(main.status === "active" || main.status === "fixing") && main.lastTool ? (
                          <span className="text-xs text-gray-400 truncate max-w-[160px]" title={`Last tool: ${main.lastTool}`}>
                            <span className="font-medium text-gray-500">tool:</span> {main.lastTool}
                          </span>
                        ) : null}
                      </div>
                    )}

                    {/* Multiple workspaces indicator */}
                    {ws.total > 1 && (
                      <div className="ml-6 mt-1 text-xs text-gray-400">
                        +{ws.total - 1} more workspace{ws.total - 1 !== 1 ? "s" : ""}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
