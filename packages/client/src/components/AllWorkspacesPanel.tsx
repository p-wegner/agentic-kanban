import { useState, useEffect } from "react";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { apiFetch } from "../lib/api.js";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";

interface Project {
  id: string;
  name: string;
}

interface CrossProjectIssue {
  id: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  projectId: string;
  workspaceSummary?: IssueWithStatus["workspaceSummary"];
}

interface CrossProjectGroup {
  projectId: string;
  projectName: string;
  issues: CrossProjectIssue[];
}

interface AllWorkspacesPanelProps {
  columns: StatusWithIssues[];
  activeProjectId: string | null;
  onClose: () => void;
  onIssueClick: (issue: IssueWithStatus) => void;
  onProjectSwitch?: (projectId: string) => Promise<void>;
  onRefresh?: () => void;
}

type WsStatusFilter = "all" | "active" | "running" | "idle" | "reviewing" | "fixing" | "closed";

const FILTER_CHIPS: { label: string; value: WsStatusFilter }[] = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Running", value: "running" },
  { label: "Idle", value: "idle" },
  { label: "Reviewing", value: "reviewing" },
  { label: "Fixing", value: "fixing" },
  { label: "Closed", value: "closed" },
];

const WS_STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  reviewing: "bg-purple-100 text-purple-700",
  fixing: "bg-orange-100 text-orange-700",
  idle: "bg-yellow-100 text-yellow-700",
  closed: "bg-gray-100 text-gray-500 dark:text-gray-400",
};

const ISSUE_STATUS_COLORS: Record<string, string> = {
  "Todo": "bg-gray-100 text-gray-600",
  "In Progress": "bg-blue-100 text-blue-700",
  "In Review": "bg-orange-100 text-orange-700",
  "AI Reviewed": "bg-purple-100 text-purple-700",
  "Done": "bg-green-100 text-green-700",
  "Cancelled": "bg-red-100 text-red-500",
};

export function AllWorkspacesPanel({ columns, activeProjectId, onClose, onIssueClick, onProjectSwitch, onRefresh }: AllWorkspacesPanelProps) {
  const [statusFilter, setStatusFilter] = useState<WsStatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [closingIdle, setClosingIdle] = useState(false);
  const [projectFilter, setProjectFilter] = useState<string>(activeProjectId ?? "all");
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [crossProjectData, setCrossProjectData] = useState<CrossProjectGroup[] | null>(null);
  const [crossProjectLoading, setCrossProjectLoading] = useState(false);

  // Fetch list of projects for the dropdown
  useEffect(() => {
    apiFetch<Project[]>("/api/projects")
      .then((data) => setAllProjects(data))
      .catch(() => {});
  }, []);

  // Fetch cross-project data when "All projects" is selected
  useEffect(() => {
    if (projectFilter !== "all") {
      setCrossProjectData(null);
      return;
    }
    setCrossProjectLoading(true);
    apiFetch<CrossProjectGroup[]>("/api/projects/all/workspaces")
      .then((data) => setCrossProjectData(data))
      .catch(() => setCrossProjectData([]))
      .finally(() => setCrossProjectLoading(false));
  }, [projectFilter]);

  // Build the issues list depending on project filter
  const issuesWithWorkspaces: (CrossProjectIssue & { projectName?: string })[] =
    projectFilter === "all"
      ? (crossProjectData ?? [] as CrossProjectGroup[]).flatMap((g: CrossProjectGroup) =>
          g.issues.map((i: CrossProjectIssue) => ({ ...i, projectName: g.projectName }))
        )
      : columns
          .flatMap((col) => col.issues)
          .filter((issue) => issue.workspaceSummary && issue.workspaceSummary.total > 0);

  const activeCount = issuesWithWorkspaces.filter(
    (i) => ["active", "reviewing", "fixing"].includes(i.workspaceSummary?.main?.status ?? "")
  ).length;

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
    }
    onRefresh?.();
    setClosingIdle(false);
  }

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
      const matchesProject = ("projectName" in issue ? (issue.projectName ?? "") : "").toLowerCase().includes(q);
      if (!matchesTitle && !matchesBranch && !matchesProject) return false;
    }

    return true;
  });

  const showingCrossProject = projectFilter === "all";

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-[min(520px,100vw)] bg-white dark:bg-gray-900 shadow-xl flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <svg className="h-5 w-5 text-gray-600 dark:text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">All Workspaces</h2>
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {crossProjectLoading
                ? "…"
                : filtered.length === issuesWithWorkspaces.length
                  ? `(${issuesWithWorkspaces.length})`
                  : `${filtered.length} of ${issuesWithWorkspaces.length}`}
            </span>
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
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 space-y-2">
          {/* Project filter */}
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="w-full text-sm px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white dark:bg-gray-900 dark:text-gray-200"
          >
            <option value="all">All projects</option>
            {allProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          {/* Text search */}
          <input
            type="text"
            placeholder={showingCrossProject ? "Search by title, branch, or project…" : "Search by title or branch…"}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full text-sm px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-400 dark:bg-gray-900 dark:text-gray-200"
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
                    : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                }`}
              >
                {chip.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {crossProjectLoading ? (
            <div className="px-4 py-12 text-center text-sm text-gray-400 dark:text-gray-500">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-gray-500 dark:text-gray-400">
              {issuesWithWorkspaces.length === 0
                ? "No workspaces yet. Create a workspace from an issue to get started."
                : "No workspaces match the current filter."}
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {filtered.map((issue) => {
                const ws = issue.workspaceSummary!;
                const main = ws.main;
                const projectName = "projectName" in issue ? issue.projectName : undefined;

                return (
                  <div
                    key={issue.id}
                    className="px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                    onClick={async () => {
                      if (showingCrossProject && issue.projectId !== activeProjectId && onProjectSwitch) {
                        await onProjectSwitch(issue.projectId);
                      }
                      onIssueClick(issue as IssueWithStatus);
                    }}
                  >
                    {/* Issue title + status */}
                    <div className="flex items-start gap-2 mb-1.5">
                      <span className="text-xs text-gray-400 dark:text-gray-500 font-mono mt-0.5 shrink-0">
                        #{issue.issueNumber}
                      </span>
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100 flex-1 min-w-0 line-clamp-1">
                        {issue.title}
                      </span>
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${ISSUE_STATUS_COLORS[issue.statusName] ?? "bg-gray-100 text-gray-600"}`}
                      >
                        {issue.statusName}
                      </span>
                    </div>

                    {/* Project name (cross-project mode only) */}
                    {showingCrossProject && projectName && (
                      <div className="ml-6 mb-1">
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600">
                          {projectName}
                        </span>
                      </div>
                    )}

                    {/* Workspace details */}
                    {main && (
                      <div className="flex items-center gap-2 flex-wrap ml-6">
                        {/* Branch */}
                        <span className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate max-w-[180px]">
                          {main.branch}
                        </span>

                        {/* Workspace status */}
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded ${main.conflicts?.hasConflicts && main.status !== "fixing" ? "bg-red-100 text-red-700" : main.status === "closed" && main.lastSessionTriggerType === "fix-conflicts" ? "bg-orange-100 text-orange-700" : WS_STATUS_COLORS[main.status] ?? "bg-gray-100 text-gray-600"}`}
                        >
                          {main.status === "reviewing" ? "AI Reviewing" : main.status === "fixing" ? "AI Fixing Conflicts" : main.conflicts?.hasConflicts ? "Merge Conflicts" : main.status === "closed" && main.lastSessionTriggerType === "fix-conflicts" ? "merged conflicts" : main.status}
                        </span>

                        {/* Ready to merge */}
                        {main.readyForMerge && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700">
                            Ready to merge
                          </span>
                        )}

                        {/* Diff stats */}
                        {main.diffStats && main.diffStats.filesChanged > 0 && (
                          <span className="text-xs text-gray-500 dark:text-gray-400">
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
                          const humanize = (n: string) => n.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
                          const badge = map[main.lastSessionTriggerType] ?? (main.lastSessionTriggerType.startsWith("skill:") ? { label: `✨ ${humanize(main.lastSessionTriggerType.slice(6))}`, className: "bg-purple-100 text-purple-700" } : null);
                          return badge ? <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${badge.className}`}>{badge.label}</span> : null;
                        })()}

                        {/* Last session */}
                        {main.lastSessionAt && (
                          <span className="text-xs text-gray-400 dark:text-gray-500">
                            {formatRelativeTime(main.lastSessionAt)}
                          </span>
                        )}

                        {/* Context usage */}
                        {(main.status === "active" || main.status === "fixing") && main.contextTokens ? (
                          <span className="text-xs text-gray-400 dark:text-gray-500" title={`${main.contextTokens.toLocaleString()} context tokens`}>
                            {main.contextTokens >= 1000
                              ? `${Math.round(main.contextTokens / 1000)}k ctx`
                              : `${main.contextTokens} ctx`}
                          </span>
                        ) : null}

                        {/* Last tool */}
                        {(main.status === "active" || main.status === "fixing") && main.lastTool ? (
                          <span className="text-xs text-gray-400 dark:text-gray-500 truncate max-w-[160px]" title={`Last tool: ${main.lastTool}`}>
                            <span className="font-medium text-gray-500 dark:text-gray-400">tool:</span> {main.lastTool}
                          </span>
                        ) : null}
                      </div>
                    )}

                    {/* Multiple workspaces indicator */}
                    {ws.total > 1 && (
                      <div className="ml-6 mt-1 text-xs text-gray-400 dark:text-gray-500">
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
