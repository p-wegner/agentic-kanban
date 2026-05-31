import { useMemo, useState } from "react";
import type { CreateIssueRequest, IssueWithStatus, ProfileSelection, StatusWithIssues } from "@agentic-kanban/shared";
import type { CreateIssueFormState } from "./CreateIssueForm.js";
import { CreateIssueForm } from "./CreateIssueForm.js";
import { IssueCard } from "./IssueCard.js";
import type { LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";

type SortMode = "rank" | "newest" | "oldest" | "priority" | "type" | "due";
type GroupMode = "none" | "priority" | "type";

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const TYPE_ORDER: Record<string, number> = {
  bug: 0,
  feature: 1,
  task: 2,
  chore: 3,
};

const PRIORITY_LABEL: Record<string, string> = {
  critical: "Critical",
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const TYPE_LABEL: Record<string, string> = {
  bug: "Bug",
  feature: "Feature",
  task: "Task",
  chore: "Chore",
};

const FILTERS = [
  { id: "all", label: "All" },
  { id: "blocked", label: "Blocked" },
  { id: "ready", label: "Ready" },
  { id: "workspace", label: "Has Workspace" },
] as const;

type FilterMode = (typeof FILTERS)[number]["id"];

export interface BacklogViewProps {
  backlogColumn: StatusWithIssues | undefined;
  activeColumns: StatusWithIssues[];
  projectId: string;
  searchQuery: string;
  sessionActivity: Record<string, string>;
  liveStats: Record<string, LiveSessionStats>;
  sessionTodos: Record<string, TodoItem[]>;
  pendingWorkspaceIssueIds: Set<string>;
  canStartWorkspace: boolean;
  onIssueClick: (issue: IssueWithStatus) => void;
  onWorkspaceClick: (issue: IssueWithStatus, workspaceId?: string) => void;
  onStartWorkspace: (issue: IssueWithStatus) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  onDrop: (statusId: string, sortOrder?: number) => void;
  onMoved: () => void;
  onCreateIssue: (data: CreateIssueRequest & { startWorkspace?: boolean; planMode?: boolean; skipAutoReview?: boolean; profile?: ProfileSelection; model?: string; isDirect?: boolean; skillId?: string }) => Promise<void>;
  onExpandCreate: (statusId: string, statusName: string, state: Partial<CreateIssueFormState>) => void;
}

export function BacklogView({
  backlogColumn,
  activeColumns,
  projectId,
  searchQuery,
  sessionActivity,
  liveStats,
  sessionTodos,
  pendingWorkspaceIssueIds,
  canStartWorkspace,
  onIssueClick,
  onWorkspaceClick,
  onStartWorkspace,
  onDragStart,
  onDrop,
  onMoved,
  onCreateIssue,
  onExpandCreate,
}: BacklogViewProps) {
  const [sortMode, setSortMode] = useState<SortMode>("rank");
  const [groupMode, setGroupMode] = useState<GroupMode>("none");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [showCreate, setShowCreate] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkMoving, setBulkMoving] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const backlogIssues = backlogColumn?.issues ?? [];
  const q = searchQuery.toLowerCase();

  const filteredIssues = useMemo(() => {
    return backlogIssues.filter((issue) => {
      if (q && !issue.title.toLowerCase().includes(q) && !(issue.description?.toLowerCase().includes(q) ?? false)) {
        return false;
      }
      if (filterMode === "blocked") return Boolean(issue.isBlocked);
      if (filterMode === "ready") return !issue.isBlocked && !issue.workspaceSummary?.main;
      if (filterMode === "workspace") return Boolean(issue.workspaceSummary?.main);
      return true;
    });
  }, [backlogIssues, filterMode, q]);

  const sortedIssues = useMemo(() => {
    return [...filteredIssues].sort((a, b) => {
      switch (sortMode) {
        case "newest":
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        case "oldest":
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        case "priority":
          return (PRIORITY_ORDER[a.priority ?? "medium"] ?? 2) - (PRIORITY_ORDER[b.priority ?? "medium"] ?? 2);
        case "type":
          return (TYPE_ORDER[a.issueType ?? "task"] ?? 2) - (TYPE_ORDER[b.issueType ?? "task"] ?? 2);
        case "due": {
          const aTime = a.dueDate ? new Date(a.dueDate).getTime() : Number.POSITIVE_INFINITY;
          const bTime = b.dueDate ? new Date(b.dueDate).getTime() : Number.POSITIVE_INFINITY;
          return aTime - bTime;
        }
        case "rank":
        default:
          return a.sortOrder - b.sortOrder;
      }
    });
  }, [filteredIssues, sortMode]);

  const groups = useMemo(() => {
    if (groupMode === "none") return [{ key: "all", label: "Backlog", issues: sortedIssues }];
    const grouped = new Map<string, IssueWithStatus[]>();
    for (const issue of sortedIssues) {
      const key = groupMode === "priority" ? issue.priority ?? "medium" : issue.issueType ?? "task";
      grouped.set(key, [...(grouped.get(key) ?? []), issue]);
    }
    const entries = [...grouped.entries()].sort(([a], [b]) => {
      if (groupMode === "priority") return (PRIORITY_ORDER[a] ?? 99) - (PRIORITY_ORDER[b] ?? 99);
      return (TYPE_ORDER[a] ?? 99) - (TYPE_ORDER[b] ?? 99);
    });
    return entries.map(([key, issues]) => ({
      key,
      label: groupMode === "priority" ? PRIORITY_LABEL[key] ?? key : TYPE_LABEL[key] ?? key,
      issues,
    }));
  }, [groupMode, sortedIssues]);

  const selectedVisibleIds = sortedIssues.map((issue) => issue.id).filter((id) => selectedIds.has(id));
  const allVisibleSelected = sortedIssues.length > 0 && sortedIssues.every((issue) => selectedIds.has(issue.id));
  const moveTargetColumns = activeColumns.filter((status) => status.name === "Todo");
  const defaultTargetStatus = moveTargetColumns[0];
  const blockedCount = backlogIssues.filter((issue) => issue.isBlocked).length;
  const workspaceCount = backlogIssues.filter((issue) => issue.workspaceSummary?.main).length;
  const readyCount = backlogIssues.filter((issue) => !issue.isBlocked && !issue.workspaceSummary?.main).length;

  function toggleSelected(issueId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(issueId)) next.delete(issueId);
      else next.add(issueId);
      return next;
    });
  }

  function toggleAllVisible() {
    if (allVisibleSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const issue of sortedIssues) next.delete(issue.id);
        return next;
      });
      return;
    }
    setSelectedIds((prev) => new Set([...prev, ...sortedIssues.map((issue) => issue.id)]));
  }

  async function moveIssue(issue: IssueWithStatus, statusId: string, statusName: string) {
    try {
      await apiFetch(`/api/issues/${issue.id}`, {
        method: "PATCH",
        body: JSON.stringify({ statusId }),
      });
      onMoved();
      showToast(`Moved to ${statusName}`, "success");
    } catch {
      showToast("Failed to move issue", "error");
    }
  }

  async function bulkMove(statusId: string, statusName: string) {
    setBulkMoving(true);
    const ids = [...selectedVisibleIds];
    try {
      const results = await Promise.allSettled(ids.map((id) =>
        apiFetch(`/api/issues/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ statusId }),
        }),
      ));
      const failed = results.filter((result) => result.status === "rejected").length;
      setSelectedIds(new Set());
      onMoved();
      showToast(
        failed === 0
          ? `Moved ${ids.length} issue${ids.length === 1 ? "" : "s"} to ${statusName}`
          : `Moved ${ids.length - failed}; ${failed} failed`,
        failed === 0 ? "success" : "error",
      );
    } finally {
      setBulkMoving(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (!backlogColumn) return;
    onDrop(backlogColumn.id);
  }

  if (!backlogColumn) {
    return (
      <div className="flex flex-1 min-h-0 items-center justify-center rounded-lg border border-dashed border-gray-200 dark:border-gray-700 bg-surface-sunken dark:bg-surface-sunken-dark text-sm text-gray-500 dark:text-gray-400">
        This project does not have a Backlog status.
      </div>
    );
  }

  return (
    <div
      className={`flex flex-1 min-h-0 flex-col overflow-hidden rounded-lg border bg-surface-sunken dark:bg-surface-sunken-dark ${
        dragOver ? "border-brand-400 ring-2 ring-brand-300" : "border-black/[0.07] dark:border-white/10"
      }`}
      onDragEnter={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="shrink-0 border-b border-black/[0.07] dark:border-white/10 bg-surface-raised dark:bg-surface-raised-dark px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-ink dark:text-gray-100">Backlog</h2>
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                {backlogIssues.length}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
              <span>{readyCount} ready</span>
              <span>{blockedCount} blocked</span>
              <span>{workspaceCount} with workspace</span>
              {searchQuery && <span>{sortedIssues.length} matching search</span>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={toggleAllVisible}
              className="rounded border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {allVisibleSelected ? "Clear Visible" : "Select Visible"}
            </button>
            <button
              onClick={() => setShowCreate((value) => !value)}
              className="rounded border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-900/40 dark:text-brand-300"
            >
              {showCreate ? "Close Create" : "New Backlog Issue"}
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-gray-200 bg-white p-0.5 dark:border-gray-700 dark:bg-gray-900">
            {FILTERS.map((filter) => (
              <button
                key={filter.id}
                onClick={() => setFilterMode(filter.id)}
                className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                  filterMode === filter.id
                    ? "bg-brand-600 text-white"
                    : "text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800"
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            Sort
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              className="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
            >
              <option value="rank">Manual order</option>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="priority">Priority</option>
              <option value="type">Type</option>
              <option value="due">Due date</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            Group
            <select
              value={groupMode}
              onChange={(e) => setGroupMode(e.target.value as GroupMode)}
              className="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
            >
              <option value="none">None</option>
              <option value="priority">Priority</option>
              <option value="type">Type</option>
            </select>
          </label>
        </div>

        {selectedVisibleIds.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-brand-200 bg-brand-50 px-3 py-2 dark:border-brand-800 dark:bg-brand-900/30">
            <span className="text-xs font-medium text-brand-700 dark:text-brand-300">
              {selectedVisibleIds.length} selected
            </span>
            <button
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-brand-600 underline dark:text-brand-300"
            >
              Clear
            </button>
            <div className="h-4 w-px bg-brand-200 dark:bg-brand-800" />
            {moveTargetColumns.map((status) => (
              <button
                key={status.id}
                disabled={bulkMoving}
                onClick={() => bulkMove(status.id, status.name)}
                className="rounded border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Move to {status.name}
              </button>
            ))}
          </div>
        )}

        {showCreate && (
          <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
            <CreateIssueForm
              projectId={projectId}
              statusId={backlogColumn.id}
              onSubmit={onCreateIssue}
              onCancel={() => setShowCreate(false)}
              canStartWorkspace={canStartWorkspace}
              onExpand={(state) => {
                setShowCreate(false);
                onExpandCreate(backlogColumn.id, backlogColumn.name, state);
              }}
            />
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {sortedIssues.length === 0 ? (
          <div className="flex h-full min-h-56 items-center justify-center rounded-lg border border-dashed border-gray-200 bg-white text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
            {searchQuery ? "No backlog issues match the current search." : "Backlog is empty."}
          </div>
        ) : (
          <div className="space-y-4">
            {groups.map((group) => (
              <section key={group.key}>
                {groupMode !== "none" && (
                  <div className="mb-2 flex items-center gap-2 px-1">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{group.label}</h3>
                    <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                      {group.issues.length}
                    </span>
                  </div>
                )}
                <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 2xl:grid-cols-3">
                  {group.issues.map((issue) => (
                    <div key={issue.id} className="flex min-w-0 gap-2">
                      <button
                        onClick={() => toggleSelected(issue.id)}
                        aria-label={selectedIds.has(issue.id) ? `Deselect issue ${issue.issueNumber}` : `Select issue ${issue.issueNumber}`}
                        className={`mt-2 h-5 w-5 shrink-0 rounded border text-[10px] ${
                          selectedIds.has(issue.id)
                            ? "border-brand-500 bg-brand-500 text-white"
                            : "border-gray-300 bg-white text-transparent hover:border-brand-300 dark:border-gray-700 dark:bg-gray-900"
                        }`}
                        title={selectedIds.has(issue.id) ? "Deselect issue" : "Select issue"}
                      >
                        {selectedIds.has(issue.id) && (
                          <svg className="m-auto h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                            <path d="M13.5 4.5 6.25 11.75 2.5 8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </button>
                      <div className="min-w-0 flex-1">
                        <IssueCard
                          issue={issue}
                          onClick={onIssueClick}
                          onWorkspaceClick={onWorkspaceClick}
                          onStartWorkspace={onStartWorkspace}
                          onDragStart={onDragStart}
                          onMoveToNext={defaultTargetStatus ? (iss) => moveIssue(iss, defaultTargetStatus.id, defaultTargetStatus.name) : undefined}
                          nextStatusName={defaultTargetStatus?.name}
                          searchQuery={searchQuery}
                          liveActivity={sessionActivity[issue.id]}
                          liveStats={liveStats[issue.id]}
                          todos={sessionTodos[issue.id]}
                          isPendingWorkspace={pendingWorkspaceIssueIds.has(issue.id)}
                        />
                        <div className="mt-1 flex flex-wrap gap-1">
                          {moveTargetColumns.map((status) => (
                            <button
                              key={status.id}
                              onClick={() => moveIssue(issue, status.id, status.name)}
                              className="rounded border border-gray-200 bg-white px-2 py-0.5 text-[10px] font-medium text-gray-500 hover:border-brand-200 hover:text-brand-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:text-brand-300"
                            >
                              {status.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
