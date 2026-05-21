import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layout } from "../components/Layout.js";
import { GraphView } from "../components/GraphView.js";
import { TableView } from "../components/TableView.js";
import { BoardColumn } from "../components/BoardColumn.js";
import { CompletedGrid } from "../components/CompletedGrid.js";
import { BoardStats } from "../components/BoardStats.js";
import { CreateIssueForm } from "../components/CreateIssueForm.js";
import { CreateIssuePanel } from "../components/CreateIssuePanel.js";
import type { CreateIssueFormState } from "../components/CreateIssueForm.js";
import { IssueDetailPanel } from "../components/IssueDetailPanel.js";
import { WorkspacePanel } from "../components/WorkspacePanel.js";
import { WorktreeOverview } from "../components/WorktreeOverview.js";
import { AllWorkspacesPanel } from "../components/AllWorkspacesPanel.js";
import { SettingsPanel } from "../components/SettingsPanel.js";
import { SkeletonBoard } from "../components/SkeletonBoard.js";
import { ToastContainer, showToast } from "../components/Toast.js";
import { suggestBranchName } from "../lib/branch.js";
import { CommandPalette } from "../components/CommandPalette.js";
import { ShortcutHelp } from "../components/ShortcutHelp.js";
import { apiFetch } from "../lib/api.js";
import { useBoardEvents, type LiveSessionStats, type TodoItem, type ApprovalRequest } from "../lib/useBoardEvents.js";
import { ApprovalDialog } from "../components/ApprovalDialog.js";
import { sendDesktopNotification } from "../lib/desktop.js";
import { registerAction } from "../lib/actions.js";
import { QuickTasksPanel } from "../components/QuickTasksPanel.js";
import type {
  CreateIssueRequest,
  IssueWithStatus,
  StatusWithIssues,
  UpdateIssueRequest,
} from "@agentic-kanban/shared";

interface Project {
  id: string;
  name: string;
  repoPath: string;
  repoName: string;
  defaultBranch: string;
  remoteUrl: string | null;
}

const ARCHIVE_STATUS_NAMES = new Set(["Done", "Cancelled"]);

type MonitorAction = { at: string; action: "relaunch" | "merge" | "nudge" | "mark_idle" | "mark_dead"; workspaceId: string; issueId: string };
type MonitorStatus = { enabled: boolean; intervalMin: number; active: boolean; lastRun: { at: string; relaunched: number; merged: number; nudged: number } | null; nextRunAt: string | null; recentActions: MonitorAction[] };

const ACTION_LABELS: Record<MonitorAction["action"], { label: string; color: string }> = {
  relaunch: { label: "Relaunched agent", color: "text-blue-600" },
  merge:    { label: "Triggered merge",  color: "text-purple-600" },
  nudge:    { label: "Nudged agent",     color: "text-amber-600" },
  mark_idle:{ label: "Marked idle",      color: "text-gray-500" },
  mark_dead:{ label: "Marked dead",      color: "text-red-500" },
};

function MonitorPopover({ status, onClose, onOpenWorkspace, columns }: { status: MonitorStatus | null; onClose: () => void; onOpenWorkspace: (workspaceId: string, issueId: string) => void; columns: StatusWithIssues[] }) {
  const [now, setNow] = useState(Date.now());
  const issueMap = useMemo(() => {
    const m = new Map<string, IssueWithStatus>();
    for (const col of columns) for (const issue of col.issues) m.set(issue.id, issue);
    return m;
  }, [columns]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    function handler(e: MouseEvent) {
      const el = document.getElementById("monitor-popover");
      if (el && !el.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  function formatCountdown(isoStr: string) {
    const ms = new Date(isoStr).getTime() - now;
    if (ms <= 0) return "now";
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
  }

  function formatAge(isoStr: string) {
    const s = Math.floor((now - new Date(isoStr).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
  }

  return (
    <div
      id="monitor-popover"
      className="absolute right-0 top-full mt-1.5 z-50 w-80 bg-white border border-gray-200 rounded-lg shadow-lg text-xs"
    >
      <div className="px-3 py-2.5 border-b border-gray-100 flex items-center justify-between">
        <span className="font-semibold text-gray-700">Board Monitor</span>
        <span className="flex items-center gap-1.5 text-green-600">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          Active
        </span>
      </div>

      <div className="px-3 py-2 border-b border-gray-100 space-y-1.5">
        {status?.lastRun ? (
          <div className="flex justify-between text-gray-500">
            <span>Last run</span>
            <span className="text-gray-700">{formatAge(status.lastRun.at)} — {new Date(status.lastRun.at).toLocaleTimeString()}</span>
          </div>
        ) : (
          <div className="text-gray-400">No runs yet this session</div>
        )}
        {status?.nextRunAt && (
          <div className="flex justify-between text-gray-500">
            <span>Next run</span>
            <span className="font-medium text-gray-700">{formatCountdown(status.nextRunAt)}</span>
          </div>
        )}
        {status?.intervalMin && (
          <div className="flex justify-between text-gray-500">
            <span>Interval</span>
            <span>{status.intervalMin}m</span>
          </div>
        )}
        {status?.lastRun && (
          <div className="flex gap-3 pt-0.5">
            {status.lastRun.relaunched > 0 && <span className="text-blue-600">{status.lastRun.relaunched} relaunched</span>}
            {status.lastRun.merged > 0 && <span className="text-purple-600">{status.lastRun.merged} merged</span>}
            {status.lastRun.nudged > 0 && <span className="text-amber-600">{status.lastRun.nudged} nudged</span>}
            {status.lastRun.relaunched === 0 && status.lastRun.merged === 0 && status.lastRun.nudged === 0 && (
              <span className="text-gray-400">No actions needed</span>
            )}
          </div>
        )}
      </div>

      {status?.recentActions && status.recentActions.length > 0 ? (
        <div className="px-3 py-2">
          <div className="text-gray-400 font-medium uppercase tracking-wide mb-1.5" style={{ fontSize: "10px" }}>Recent actions</div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {status.recentActions.map((a, i) => {
              const meta = ACTION_LABELS[a.action];
              const issue = issueMap.get(a.issueId);
              const label = issue ? `#${issue.issueNumber} ${issue.title}` : a.workspaceId.slice(0, 8);
              return (
                <div key={i} className="flex items-center justify-between gap-2 min-w-0">
                  <span className={`${meta.color} font-medium shrink-0`}>{meta.label}</span>
                  <button
                    className="text-blue-500 hover:text-blue-700 hover:underline truncate text-left min-w-0 flex-1"
                    style={{ fontSize: "11px" }}
                    onClick={() => { onOpenWorkspace(a.workspaceId, a.issueId); onClose(); }}
                    title={issue ? issue.title : a.workspaceId}
                  >{label}</button>
                  <span className="text-gray-400 shrink-0">{formatAge(a.at)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="px-3 py-2 text-gray-400">No actions recorded yet</div>
      )}

      <div className="px-3 py-2 border-t border-gray-100 text-gray-400">
        Configure in Settings → Workflow
      </div>
    </div>
  );
}

export function BoardPage() {
  const [columns, setColumns] = useState<StatusWithIssues[]>([]);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [creatingInColumnId, setCreatingInColumnId] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<IssueWithStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const [workspaceIssue, setWorkspaceIssue] = useState<IssueWithStatus | null>(null);
  const [workspaceInitial, setWorkspaceInitial] = useState<{ workspaceId: string; sessionId: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");

  const filteredColumns = useMemo(
    () =>
      columns.map((col) => ({
        ...col,
        issues: col.issues.filter((issue) => {
          if (priorityFilter && issue.priority !== priorityFilter) return false;
          if (searchQuery) {
            const q = searchQuery.toLowerCase();
            return (
              issue.title.toLowerCase().includes(q) ||
              (issue.description?.toLowerCase().includes(q) ?? false)
            );
          }
          return true;
        }),
      })),
    [columns, searchQuery, priorityFilter],
  );

  // "AI Reviewed" = tickets needing human attention (manual merge).
  // Hide the column when no tickets are there AND the workflow won't produce them
  // (auto_review off, or auto_merge on means review goes straight to Done).
  const showAiReviewedColumn = useMemo(
    () =>
      columns.some((col) => col.name === "AI Reviewed" && col.issues.length > 0) ||
      (autoReview && !autoMerge),
    [columns, autoReview, autoMerge],
  );

  const activeColumns = useMemo(
    () =>
      filteredColumns.filter(
        (col) =>
          !ARCHIVE_STATUS_NAMES.has(col.name) &&
          (col.name !== "AI Reviewed" || showAiReviewedColumn),
      ),
    [filteredColumns, showAiReviewedColumn],
  );
  const archiveColumns = useMemo(
    () => filteredColumns.filter((col) => ARCHIVE_STATUS_NAMES.has(col.name)),
    [filteredColumns],
  );

  function toggleGroup(group: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  }

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ctrl+K to open command palette
      if (e.key === "k" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        setShowCommandPalette(true);
        return;
      }
      // "/" to focus search
      if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
        e.preventDefault();
        const input = document.getElementById("search-input") as HTMLInputElement | null;
        if (input) {
          input.focus();
          // Clear any stray "/" that leaked through before focus shift
          requestAnimationFrame(() => {
            if (input.value === "/") {
              input.value = "";
              setSearchQuery("");
            }
          });
        }
      }
      // Escape to close palette / shortcut help / clear search / close panels
      if (e.key === "Escape") {
        if (showCommandPalette) {
          setShowCommandPalette(false);
          return;
        }
        if (showAllWorkspaces) {
          setShowAllWorkspaces(false);
          return;
        }
        if (showWorktreeOverview) {
          setShowWorktreeOverview(false);
          return;
        }
        if (showShortcutHelp) {
          setShowShortcutHelp(false);
          return;
        }
        if (searchQuery) {
          setSearchQuery("");
          document.getElementById("search-input")?.blur();
        }
      }
      // "?" to show keyboard shortcuts
      if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
        e.preventDefault();
        setShowShortcutHelp((prev) => !prev);
      }
      // "t" to open Quick Tasks
      if (e.key === "t" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
        e.preventDefault();
        setShowQuickTasks(true);
      }
      // "c" to create issue, "w" to create issue + workspace
      if ((e.key === "c" || e.key === "w") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
        e.preventDefault();
        const col = filteredColumns[0] ?? columns[0];
        if (!col) return;
        if (e.key === "w") {
          setExpandedCreatePanel({ statusId: col.id, statusName: col.name, state: { startWorkspace: true } });
        } else {
          setCreatingInColumnId(col.id);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [searchQuery, showCommandPalette, showAllWorkspaces, showWorktreeOverview, showShortcutHelp, filteredColumns, columns]);

  // Register command palette actions
  useEffect(() => {
    const unregisters: (() => void)[] = [];

    unregisters.push(registerAction({
      id: "create-issue",
      label: "Create Issue",
      description: "Add a new issue to the board",
      icon: "+",
      shortcut: "c",
      category: "issue",
      handler: () => {
        if (filteredColumns.length > 0) {
          setCreatingInColumnId(filteredColumns[0].id);
        }
      },
    }));

    unregisters.push(registerAction({
      id: "create-issue-with-workspace",
      label: "New Issue + Start Workspace",
      shortcut: "w",
      category: "issue",
      handler: () => {
        const col = filteredColumns[0] ?? columns[0];
        if (col) {
          setExpandedCreatePanel({ statusId: col.id, statusName: col.name, state: { startWorkspace: true } });
        }
      },
    }));

    unregisters.push(registerAction({
      id: "switch-project",
      label: "Switch Project",
      description: "Change the active project",
      icon: "⇄",
      category: "navigation",
      handler: () => {
        document.querySelector<HTMLButtonElement>("[data-project-switcher]")?.click();
      },
    }));

    unregisters.push(registerAction({
      id: "open-settings",
      label: "Open Settings",
      description: "Configure agent, preferences, and project settings",
      icon: "⚙",
      category: "settings",
      handler: () => setShowSettings(true),
    }));

    unregisters.push(registerAction({
      id: "view-all-workspaces",
      label: "All Workspaces",
      description: "View all workspaces with status, diff stats, and session activity",
      icon: "⊞",
      category: "navigation",
      handler: () => setShowAllWorkspaces(true),
    }));

    unregisters.push(registerAction({
      id: "view-worktrees",
      label: "View Worktrees",
      description: "Inspect git worktrees and their diff stats",
      icon: "⎇",
      category: "navigation",
      handler: () => setShowWorktreeOverview(true),
    }));

    unregisters.push(registerAction({
      id: "search-issues",
      label: "Search Issues",
      description: "Filter issues by text or keyword",
      icon: "⌕",
      shortcut: "/",
      category: "board",
      handler: () => document.getElementById("search-input")?.focus(),
    }));

    unregisters.push(registerAction({
      id: "show-shortcuts",
      label: "Keyboard Shortcuts",
      description: "View all available keyboard shortcuts",
      icon: "?",
      shortcut: "?",
      category: "settings",
      handler: () => setShowShortcutHelp(true),
    }));

    // Register "Go to: [column]" for each column
    for (const col of columns) {
      unregisters.push(registerAction({
        id: `goto-${col.id}`,
        label: `Go to: ${col.name}`,
        description: `Scroll to the ${col.name} column`,
        category: "navigation",
        handler: () => {
          const el = document.getElementById(`column-${col.id}`);
          el?.scrollIntoView({ behavior: "smooth", inline: "center" });
        },
      }));
    }

    return () => unregisters.forEach((fn) => fn());
  }, [columns, filteredColumns]);

  if (loading) {
    return (
      <Layout onRegisterProject={handleRegisterProject} onCreateProject={handleCreateProject}>
        <SkeletonBoard />
      </Layout>
    );
  }

  // No projects registered
  if (projects.length === 0 || !activeProjectId) {
    return (
      <Layout onRegisterProject={handleRegisterProject} onCreateProject={handleCreateProject}>
        <div className="flex items-center justify-center h-96 text-gray-500">
          <div className="text-center">
            <p className="text-lg font-medium text-gray-700 mb-2">
              No projects registered
            </p>
            <p className="text-sm text-gray-500">
              Click the <strong>+</strong> button in the header to register a git repo as a project.
            </p>
          </div>
        </div>
      </Layout>
    );
  }

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const canStartWorkspace = !!activeProject?.repoPath;

  return (
    <Layout
      projects={projects}
      activeProjectId={activeProjectId}
      onProjectChange={handleProjectChange}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      onRegisterProject={handleRegisterProject}
      onCreateProject={handleCreateProject}
      onSettingsClick={() => setShowSettings(true)}
      onAllWorkspacesClick={() => setShowAllWorkspaces(true)}
      onWorktreeOverviewClick={() => setShowWorktreeOverview(true)}
    >
      {error && (
        <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-200 rounded-md flex items-center justify-between">
          <span className="text-sm text-red-700">{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-600 text-sm"
          >
            Dismiss
          </button>
        </div>
      )}
      {mutating && (
        <div className="fixed bottom-4 right-4 z-50">
          <div className="bg-blue-600 text-white rounded-lg px-4 py-2 flex items-center gap-2 shadow-lg">
            <svg
              className="animate-spin h-4 w-4 text-white"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span className="text-sm font-medium">Saving...</span>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-3 p-4 h-full overflow-hidden">
        <div className="flex items-center gap-2 flex-wrap">
          <BoardStats
            activeColumns={activeColumns}
            archiveColumns={archiveColumns}
            searchQuery={searchQuery}
            projectId={activeProjectId}
          />
          <button
            onClick={() => setShowQuickTasks(true)}
            title="Quick Tasks — run a skill directly on the main branch (t)"
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-white border-gray-200 text-gray-600 hover:bg-gray-50"
          >
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <polygon points="5,3 19,12 5,21" />
            </svg>
            Tasks
          </button>
          {autoMonitor && (
            <div className="relative shrink-0">
              <button
                onClick={() => setShowMonitorPopover(v => !v)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-green-50 border-green-200 text-green-700 hover:bg-green-100"
                title="Board monitor active — click for details"
              >
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                Monitor
              </button>
              {showMonitorPopover && <MonitorPopover
                status={monitorStatus}
                onClose={() => setShowMonitorPopover(false)}
                columns={columns}
                onOpenWorkspace={(workspaceId, issueId) => {
                  const issue = columns.flatMap(c => c.issues).find(i => i.id === issueId);
                  if (issue) handleManageWorkspaces(issue, workspaceId);
                }}
              />}
            </div>
          )}
          <div className="flex items-center gap-1 border border-gray-200 rounded-md p-0.5 bg-white shrink-0">
            <button
              onClick={() => setViewMode("kanban")}
              className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "kanban" ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"}`}
              title="Kanban view"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <rect x="3" y="3" width="5" height="18" rx="1" />
                <rect x="10" y="3" width="5" height="14" rx="1" />
                <rect x="17" y="3" width="5" height="10" rx="1" />
              </svg>
              Board
            </button>
            <button
              onClick={() => setViewMode("graph")}
              className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "graph" ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"}`}
              title="Graph view"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="5" cy="12" r="2" />
                <circle cx="19" cy="5" r="2" />
                <circle cx="19" cy="19" r="2" />
                <path d="M7 12h6M15 6.5l-4 4M15 17.5l-4-4" />
              </svg>
              Graph
            </button>
            <button
              onClick={() => setViewMode("table")}
              className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "table" ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"}`}
              title="Table view"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path d="M3 6h18M3 12h18M3 18h18M8 6v12" />
              </svg>
              Table
            </button>
          </div>
        </div>
        {viewMode === "graph" && activeProjectId ? (
          <div className="flex-1 min-h-0">
            <GraphView
              columns={columns}
              projectId={activeProjectId}
              onIssueClick={handleIssueClick}
              searchQuery={searchQuery}
            />
          </div>
        ) : null}
        {viewMode === "table" && (
          <TableView
            columns={columns}
            onIssueClick={handleIssueClick}
            searchQuery={searchQuery}
          />
        )}
        {viewMode === "kanban" && activeColumns.length > 1 && (
          <div className="flex sm:hidden gap-1 overflow-x-auto scrollbar-hide shrink-0">
            {activeColumns.map((col) => (
              <button
                key={col.id}
                onClick={() => {
                  document.getElementById(`column-${col.id}`)?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
                }}
                className="shrink-0 px-3 py-1 text-xs rounded-full border border-gray-200 bg-white text-gray-600 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 transition-colors"
              >
                {col.name}
                <span className="ml-1 text-gray-400">{col.issues.length}</span>
              </button>
            ))}
          </div>
        )}
        {viewMode === "kanban" && <div className="flex gap-4 flex-1 min-h-0 overflow-x-auto board-columns-scroll">
          {activeColumns.map((col) => (
            <BoardColumn
              key={col.id}
              column={col}
              style={dynamicColumnScaling ? { flexGrow: Math.max(1, col.issues.length) } : undefined}
              projectId={activeProjectId}
              creatingInColumn={creatingInColumnId}
              onCreateClick={setCreatingInColumnId}
              onCreateCancel={() => setCreatingInColumnId(null)}
              onIssueClick={handleIssueClick}
              onWorkspaceClick={handleManageWorkspaces}
              onStartWorkspace={handleStartWorkspace}
              onDragStart={(e, issue) => {
                (window as unknown as Record<string, unknown>).__dragData = {
                  issueId: issue.id,
                  sourceStatusId: issue.statusId,
                };
                handleDragStart(e, issue);
              }}
              onDrop={handleDrop}
              searchQuery={searchQuery}
              sessionActivity={sessionActivity}
              liveStats={liveStats}
              sessionTodos={sessionTodos}
            >
              <CreateIssueForm
                projectId={activeProjectId}
                statusId={col.id}
                onSubmit={handleCreateIssue}
                onCancel={() => setCreatingInColumnId(null)}
                canStartWorkspace={canStartWorkspace}
                onExpand={(state) => {
                  setCreatingInColumnId(null);
                  setExpandedCreatePanel({ statusId: col.id, statusName: col.name, state });
                }}
              />
            </BoardColumn>
          ))}
        </div>}
        {viewMode === "kanban" && <CompletedGrid
          columns={archiveColumns}
          collapsed={collapsedGroups.has("archive")}
          onToggle={() => toggleGroup("archive")}
          onIssueClick={handleIssueClick}
          onDragStart={(e, issue) => {
            (window as unknown as Record<string, unknown>).__dragData = {
              issueId: issue.id,
              sourceStatusId: issue.statusId,
            };
            handleDragStart(e, issue);
          }}
          onDrop={handleDrop}
          searchQuery={searchQuery}
        />}
      </div>
      {selectedIssue && (
        <IssueDetailPanel
          issue={selectedIssue}
          statuses={columns.map((col) => ({ id: col.id, name: col.name }))}
          onUpdate={handleUpdateIssue}
          onDelete={handleDeleteIssue}
          onClose={() => setSelectedIssue(null)}
          onManageWorkspaces={handleManageWorkspaces}
          onStartWorkspace={handleStartWorkspace}
          onIssueUpdate={setSelectedIssue}
          onNavigateToIssue={(issueId) => {
            for (const col of columns) {
              const found = col.issues.find((i) => i.id === issueId);
              if (found) {
                setSelectedIssue(found);
                return;
              }
            }
          }}
        />
      )}
      {workspaceIssue && (
        <WorkspacePanel
          issue={workspaceIssue}
          project={activeProject ?? null}
          onClose={() => { setWorkspaceIssue(null); setWorkspaceInitial(null); }}
          onWorkspaceChange={() => refetchBoard()}
          initialWorkspaceId={workspaceInitial?.workspaceId}
          initialSessionId={workspaceInitial?.sessionId}
        />
      )}
      <ApprovalDialog
        requests={approvalRequests}
        onResolve={(id) => setApprovalRequests((prev) => prev.filter((r) => r.id !== id))}
      />
      <ToastContainer />
      {showSettings && (
        <SettingsPanel onClose={() => {
          setShowSettings(false);
          apiFetch<Record<string, string>>("/api/preferences/settings")
            .then(s => {
              setAutoReview(s.auto_review !== "false");
              setAutoMerge(s.auto_merge !== "false");
              setAutoMonitor(s.auto_monitor === "true");
              return apiFetch<MonitorStatus>("/api/internal/monitor-status");
            })
            .then(r => setMonitorStatus(r))
            .catch(() => {});
        }} activeProjectId={activeProjectId} />
      )}
      {showQuickTasks && activeProjectId && (
        <QuickTasksPanel
          projectId={activeProjectId}
          onClose={() => setShowQuickTasks(false)}
          onLaunched={() => refetchBoard()}
        />
      )}
      {showAllWorkspaces && (
        <AllWorkspacesPanel
          columns={columns}
          onClose={() => setShowAllWorkspaces(false)}
          onIssueClick={(issue) => {
            setSelectedIssue(issue);
            setShowAllWorkspaces(false);
          }}
        />
      )}
      {showWorktreeOverview && activeProjectId && (
        <WorktreeOverview
          projectId={activeProjectId}
          onClose={() => setShowWorktreeOverview(false)}
          onIssueClick={(issueId: string) => {
            for (const col of columns) {
              const found = col.issues.find((i) => i.id === issueId);
              if (found) {
                setSelectedIssue(found);
                break;
              }
            }
            setShowWorktreeOverview(false);
          }}
          onWorkspaceChange={() => refetchBoard()}
        />
      )}
      {showCommandPalette && (
        <CommandPalette onClose={() => setShowCommandPalette(false)} />
      )}
      {showShortcutHelp && (
        <ShortcutHelp onClose={() => setShowShortcutHelp(false)} />
      )}
      {expandedCreatePanel && activeProjectId && (
        <CreateIssuePanel
          projectId={activeProjectId}
          statusId={expandedCreatePanel.statusId}
          statusName={expandedCreatePanel.statusName}
          initialState={expandedCreatePanel.state}
          onSubmit={handleCreateIssue}
          onClose={() => setExpandedCreatePanel(null)}
          canStartWorkspace={canStartWorkspace}
        />
      )}
    </Layout>
  );
}
