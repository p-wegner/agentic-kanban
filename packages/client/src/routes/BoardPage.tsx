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
  const [showSettings, setShowSettings] = useState(false);
  const [showQuickTasks, setShowQuickTasks] = useState(false);
  const [showWorktreeOverview, setShowWorktreeOverview] = useState(false);
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(["archive"]),
  );
  const [sessionActivity, setSessionActivity] = useState<Record<string, string>>({});
  const [liveStats, setLiveStats] = useState<Record<string, LiveSessionStats>>({});
  const [sessionTodos, setSessionTodos] = useState<Record<string, TodoItem[]>>({});
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);
  const pendingBoardRefreshRef = useRef(false);
  const [expandedCreatePanel, setExpandedCreatePanel] = useState<{ statusId: string; statusName: string; state: Partial<CreateIssueFormState> } | null>(null);
  const [viewMode, setViewMode] = useState<"kanban" | "graph" | "table">("kanban");
  const [dynamicColumnScaling, setDynamicColumnScaling] = useState(false);
  const [autoMonitor, setAutoMonitor] = useState(false);
  const [monitorLastRun, setMonitorLastRun] = useState<{ at: string; relaunched: number; merged: number; nudged: number } | null>(null);

  const refetchBoard = useCallback(async (projectId?: string) => {
    const pid = projectId || activeProjectId;
    if (!pid) return;
    const board = await apiFetch<StatusWithIssues[]>(
      `/api/projects/${pid}/board`,
    );
    setColumns(board);
    return board;
  }, [activeProjectId]);

  // Keep selectedIssue in sync with board data (F6 stale data fix)
  useEffect(() => {
    if (!selectedIssue) return;
    for (const col of columns) {
      const found = col.issues.find((i) => i.id === selectedIssue.id);
      if (found) {
        // Only update if data actually changed to avoid unnecessary re-renders
        if (found.title !== selectedIssue.title ||
            found.description !== selectedIssue.description ||
            found.priority !== selectedIssue.priority ||
            found.statusId !== selectedIssue.statusId ||
            found.statusName !== selectedIssue.statusName ||
            found.updatedAt !== selectedIssue.updatedAt) {
          setSelectedIssue(found);
        }
        return;
      }
    }
    // Issue was deleted — close panel
    setSelectedIssue(null);
  }, [columns, selectedIssue]);

  // Real-time board updates via WebSocket (debounced while create form is open)
  useBoardEvents(activeProjectId, useCallback((reason: string) => {
    console.log(`[board-events] board changed: ${reason}`);
    // Desktop notification for agent events
    if (reason === "session_completed") {
      sendDesktopNotification("Agentic Kanban", "Agent session completed");
    } else if (reason === "workspace_merged") {
      sendDesktopNotification("Agentic Kanban", "Workspace merged successfully");
    }
    if (creatingInColumnId) {
      // Don't refresh while create form is open — batch the update
      pendingBoardRefreshRef.current = true;
      return;
    }
    refetchBoard();
  }, [refetchBoard, creatingInColumnId]), useCallback((issueId: string, activity: string) => {
    setSessionActivity((prev) => {
      if (!activity) {
        const next = { ...prev };
        delete next[issueId];
        return next;
      }
      if (prev[issueId] === activity) return prev;
      return { ...prev, [issueId]: activity };
    });
  }, []), useCallback((issueId: string, stats: LiveSessionStats) => {
    setLiveStats((prev) => {
      if (prev[issueId]?.model === stats.model && prev[issueId]?.contextTokens === stats.contextTokens && prev[issueId]?.toolUses === stats.toolUses && prev[issueId]?.subagentCount === stats.subagentCount) return prev;
      return { ...prev, [issueId]: stats };
    });
  }, []), useCallback((issueId: string, todos: TodoItem[]) => {
    setSessionTodos((prev) => ({ ...prev, [issueId]: todos }));
  }, []), useCallback((req: ApprovalRequest) => {
    setApprovalRequests((prev) => [...prev, req]);
  }, []));

  // Process pending board refresh when create form closes
  useEffect(() => {
    if (!creatingInColumnId && pendingBoardRefreshRef.current) {
      pendingBoardRefreshRef.current = false;
      refetchBoard();
    }
  }, [creatingInColumnId, refetchBoard]);

  const loadProjects = useCallback(async () => {
    const projs = await apiFetch<Project[]>("/api/projects");
    setProjects(projs);
    if (projs.length === 0) return;

    // Get active project preference
    try {
      const pref = await apiFetch<{ projectId: string | null }>("/api/preferences/active-project");
      if (pref.projectId && projs.some((p) => p.id === pref.projectId)) {
        setActiveProjectId(pref.projectId);
        return pref.projectId;
      }
    } catch {
      // Ignore — fall back to first project
    }

    // Fallback to first project
    const firstId = projs[0].id;
    setActiveProjectId(firstId);
    return firstId;
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const pid = await loadProjects();
        if (pid) {
          const board = await apiFetch<StatusWithIssues[]>(
            `/api/projects/${pid}/board`,
          );
          setColumns(board);
        }
        try {
          const s = await apiFetch<Record<string, string>>("/api/preferences/settings");
          setDynamicColumnScaling(s.dynamic_column_scaling === "true");
          setAutoMonitor(s.auto_monitor === "true");
          apiFetch<{ lastRun: typeof monitorLastRun }>("/api/internal/monitor-status")
            .then((r) => setMonitorLastRun(r.lastRun))
            .catch(() => {});
        } catch {
          // ignore
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load board");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [loadProjects]);

  async function toggleAutoMonitor() {
    const next = !autoMonitor;
    setAutoMonitor(next);
    try {
      await apiFetch("/api/preferences/settings", {
        method: "PUT",
        body: JSON.stringify({ auto_monitor: String(next) }),
      });
      const status = await apiFetch<{ lastRun: typeof monitorLastRun }>("/api/internal/monitor-status");
      setMonitorLastRun(status.lastRun);
    } catch {
      setAutoMonitor(!next);
    }
  }

  async function handleProjectChange(id: string) {
    setActiveProjectId(id);
    try {
      await apiFetch("/api/preferences/active-project", {
        method: "PUT",
        body: JSON.stringify({ projectId: id }),
      });
      await refetchBoard(id);
    } catch (err) {
      showToast("Failed to switch project", "error");
    }
  }

  async function handleRegisterProject({ repoPath, gitignoreTemplate, generateReadme }: { repoPath: string; gitignoreTemplate: string; generateReadme: boolean }) {
    const result = await apiFetch<{ id: string; name: string; error?: string }>(
      "/api/projects",
      { method: "POST", body: JSON.stringify({ repoPath, gitignoreTemplate: gitignoreTemplate || undefined, generateReadme: generateReadme || undefined }) },
    );
    if (result.error) throw new Error(result.error);
    await loadProjects();
    await handleProjectChange(result.id);
    showToast(`Registered "${result.name}"`, "success");
  }

  async function handleCreateProject(name: string, path: string) {
    const body: Record<string, string> = { name };
    if (path) body.path = path;
    const result = await apiFetch<{ id: string; name: string; error?: string }>(
      "/api/projects/create",
      { method: "POST", body: JSON.stringify(body) },
    );
    if (result.error) throw new Error(result.error);
    await loadProjects();
    await handleProjectChange(result.id);
    showToast(`Created "${result.name}"`, "success");
  }

  async function handleCreateIssue(data: CreateIssueRequest & { startWorkspace?: boolean; planMode?: boolean; claudeProfile?: string; isDirect?: boolean }) {
    setMutating(true);
    setError(null);
    const { startWorkspace, planMode, claudeProfile, isDirect, ...issueData } = data;
    try {
      const created = await apiFetch<{ id: string; issueNumber: number; title: string }>(
        "/api/issues",
        { method: "POST", body: JSON.stringify(issueData) },
      );
      setCreatingInColumnId(null);
      setExpandedCreatePanel(null);
      const board = await refetchBoard();
      pendingBoardRefreshRef.current = false;

      if (startWorkspace && activeProject) {
        try {
          const branch = suggestBranchName({
            issueNumber: created.issueNumber,
            title: created.title,
          });
          const ws = await apiFetch<{ id: string; sessionId?: string }>("/api/workspaces", {
            method: "POST",
            body: JSON.stringify({
              issueId: created.id,
              branch: isDirect ? undefined : branch,
              baseBranch: isDirect ? undefined : activeProject.defaultBranch,
              isDirect: isDirect || undefined,
              planMode: planMode || undefined,
              claudeProfile: claudeProfile || undefined,
            }),
          });
          for (const col of board ?? columns) {
            const found = col.issues.find((i) => i.id === created.id);
            if (found) {
              setWorkspaceIssue(found);
              if (ws.sessionId) {
                setWorkspaceInitial({ workspaceId: ws.id, sessionId: ws.sessionId });
              }
              break;
            }
          }
          showToast("Issue and workspace created", "success");
        } catch {
          showToast("Issue created, but workspace creation failed", "error");
        }
      } else {
        showToast("Issue created", "success");
      }
    } catch (err) {
      showToast("Failed to create issue", "error");
    } finally {
      setMutating(false);
    }
  }

  async function handleUpdateIssue(id: string, data: UpdateIssueRequest) {
    setMutating(true);
    setError(null);
    try {
      await apiFetch(`/api/issues/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
      const board = await refetchBoard();
      // Re-find updated issue in new columns to keep panel open (F1)
      // refetchBoard now returns the board data
      void board; // used below via columns state update
      showToast("Issue updated", "success");
    } catch (err) {
      showToast("Failed to update issue", "error");
    } finally {
      setMutating(false);
    }
  }

  async function handleDeleteIssue(id: string) {
    setMutating(true);
    setError(null);
    try {
      await apiFetch(`/api/issues/${id}`, { method: "DELETE" });
      setSelectedIssue(null);
      await refetchBoard();
      showToast("Issue deleted", "success");
    } catch (err) {
      showToast("Failed to delete issue", "error");
    } finally {
      setMutating(false);
    }
  }

  function handleDragStart(e: React.DragEvent, issue: IssueWithStatus) {
    e.dataTransfer.setData("application/json", JSON.stringify({
      issueId: issue.id,
      sourceStatusId: issue.statusId,
    }));
    e.dataTransfer.effectAllowed = "move";
  }

  async function handleDrop(targetStatusId: string, sortOrder?: number) {
    try {
      const raw = (window as unknown as Record<string, unknown>).__dragData;
      let issueId: string | undefined;
      let sourceStatusId: string | undefined;

      // Read from dataTransfer wasn't stored, so we use a global bridge
      if (raw && typeof raw === "object") {
        const data = raw as { issueId: string; sourceStatusId: string };
        issueId = data.issueId;
        sourceStatusId = data.sourceStatusId;
      }

      if (!issueId) return;
      if (sourceStatusId === targetStatusId && sortOrder === undefined) return;

      const body: UpdateIssueRequest = { statusId: targetStatusId };
      if (sortOrder !== undefined) body.sortOrder = sortOrder;

      await apiFetch(`/api/issues/${issueId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      await refetchBoard();
    } catch (err) {
      showToast("Failed to move issue", "error");
    }
  }

  function handleIssueClick(issue: IssueWithStatus) {
    setSelectedIssue(issue);
  }

  function handleManageWorkspaces(issue: IssueWithStatus, workspaceId?: string) {
    setSelectedIssue(null);
    setWorkspaceIssue(issue);
    if (workspaceId) {
      setWorkspaceInitial({ workspaceId, sessionId: "" });
    }
  }

  async function handleStartWorkspace(issue: IssueWithStatus) {
    if (!activeProject) return;
    setMutating(true);
    try {
      const branch = suggestBranchName({
        issueNumber: issue.issueNumber,
        title: issue.title,
      });
      const ws = await apiFetch<{ id: string; sessionId?: string }>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({
          issueId: issue.id,
          branch,
          baseBranch: activeProject.defaultBranch,
        }),
      });
      setSelectedIssue(null);
      const board = await refetchBoard();
      const updated = board?.flatMap((col) => col.issues).find((i) => i.id === issue.id) ?? issue;
      setWorkspaceIssue(updated);
      if (ws.sessionId) {
        setWorkspaceInitial({ workspaceId: ws.id, sessionId: ws.sessionId });
      } else {
        setWorkspaceInitial({ workspaceId: ws.id, sessionId: "" });
      }
      showToast("Workspace created", "success");
    } catch (err) {
      showToast("Failed to create workspace", "error");
    } finally {
      setMutating(false);
    }
  }

  // Filter columns by search query and priority
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
    [columns, searchQuery],
  );

  const activeColumns = useMemo(
    () => filteredColumns.filter((col) => !ARCHIVE_STATUS_NAMES.has(col.name)),
    [filteredColumns],
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
            <div
              title={`Auto-monitor active${monitorLastRun ? ` · Last run: ${new Date(monitorLastRun.at).toLocaleTimeString()} · ${monitorLastRun.relaunched} relaunched, ${monitorLastRun.merged} merged, ${monitorLastRun.nudged} nudged` : ""} · Configure in Settings → Agent`}
              className="shrink-0 flex items-center gap-1.5 px-2 py-1 rounded text-xs text-green-700"
            >
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
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
        <SettingsPanel onClose={() => setShowSettings(false)} activeProjectId={activeProjectId} />
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
