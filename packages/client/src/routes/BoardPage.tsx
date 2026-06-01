import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layout } from "../components/Layout.js";
import { useTheme } from "../hooks/useTheme.js";
import { GraphView } from "../components/GraphView.js";
import { TableView } from "../components/TableView.js";
import { AgentGrid } from "../components/AgentGrid.js";
import { TimelineView } from "../components/TimelineView.js";
import { MetricsView } from "../components/MetricsView.js";
import { QualityMetricsView } from "../components/QualityMetricsView.js";
import { ButlerView } from "../components/ButlerView.js";
import { WorkflowsView } from "../components/WorkflowsView.js";
import { WorkflowAnalyticsDashboard } from "../components/WorkflowAnalyticsDashboard.js";
import { InsightsPanel } from "../components/InsightsPanel.js";
import { DigestView } from "../components/DigestView.js";
import { FocusView } from "../components/FocusView.js";
import { StrategyTargetsView } from "../components/StrategyTargetsView.js";
import { SwimlaneView } from "../components/SwimlaneView.js";
import { FlakyTestsPanel } from "../components/FlakyTestsPanel.js";
import { MonitorCycleHistoryPanel } from "../components/MonitorCycleHistoryPanel.js";
import { useAgentQuestionsCount } from "../components/AgentQuestionsPanel.js";
import { BoardErrorBoundary } from "../components/BoardErrorBoundary.js";
import { BacklogView } from "../components/BacklogView.js";
import { BoardKanbanView } from "../components/BoardKanbanView.js";
import { BoardStats } from "../components/BoardStats.js";
import { BoardToolbar } from "../components/BoardToolbar.js";
import { SavedBoardViews } from "../components/SavedBoardViews.js";
import { VIEW_REGISTRY, VIEW_IDS, SHORTCUT_TO_VIEW, type ViewMode } from "../lib/viewRegistry.js";
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
import { MentionProvider } from "../lib/MentionContext.js";
import { CommandPalette } from "../components/CommandPalette.js";
import { ShortcutHelp } from "../components/ShortcutHelp.js";
import { apiFetch } from "../lib/api.js";
import { useBoardEvents, type LiveSessionStats, type TodoItem, type ApprovalRequest } from "../lib/useBoardEvents.js";
import { ApprovalDialog } from "../components/ApprovalDialog.js";
import { MoveToDoneDialog } from "../components/MoveToDoneDialog.js";
import { sendDesktopNotification } from "../lib/desktop.js";
import { registerAction } from "../lib/actions.js";
import { getAppRouteView, getViewRoutePath } from "../lib/appRoutes.js";
import { QuickTasksPanel } from "../components/QuickTasksPanel.js";
import { MergeQueuePanel } from "../components/MergeQueuePanel.js";
import { RunQueueForecastPanel, buildRunQueueForecast } from "../components/RunQueueForecastPanel.js";
import { CodemodPanel } from "../components/CodemodPanel.js";
import { TranscriptSearchPanel } from "../components/TranscriptSearchPanel.js";
import type { MonitorStatus } from "../components/MonitorPopover.js";
import type { BoardViewState, SavedViewReference } from "../lib/boardSavedViews.js";
import type {
  CreateIssueRequest,
  IssueWithStatus,
  ProfileSelection,
  StatusWithIssues,
  UpdateIssueRequest,
} from "@agentic-kanban/shared";

interface Project {
  id: string;
  name: string;
  repoPath: string;
  repoName: string;
  defaultBranch: string | null;
  remoteUrl: string | null;
}

interface Tag {
  id: string;
  name: string;
  color: string | null;
}

const ARCHIVE_STATUS_NAMES = new Set(["Done", "Cancelled"]);
const BACKLOG_STATUS_NAME = "Backlog";
const PRIORITY_OPTIONS = ["critical", "high", "medium", "low"] as const;
const PRIORITY_LABEL: Record<(typeof PRIORITY_OPTIONS)[number], string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};


export function BoardPage() {
  const { theme, setTheme, isDark } = useTheme();
  const [columns, setColumns] = useState<StatusWithIssues[]>([]);
  const columnsRef = useRef<StatusWithIssues[]>([]);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [creatingInColumnId, setCreatingInColumnId] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<IssueWithStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const [workspaceIssue, setWorkspaceIssue] = useState<IssueWithStatus | null>(null);
  const [workspaceInitial, setWorkspaceInitial] = useState<{ workspaceId: string; sessionId: string } | null>(null);
  const [workspaceOpenCreate, setWorkspaceOpenCreate] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilterId, setStatusFilterId] = useState<string | null>(null);
  const [tagFilterId, setTagFilterId] = useState<string | null>(null);
  const [createdDateFilter, setCreatedDateFilter] = useState<string | null>(null);
  const [showBlocked, setShowBlocked] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showQuickTasks, setShowQuickTasks] = useState(false);
  const [showMergeQueue, setShowMergeQueue] = useState(false);
  const [showRunQueueForecast, setShowRunQueueForecast] = useState(false);
  const [showCodemod, setShowCodemod] = useState(false);
  const [showWorktreeOverview, setShowWorktreeOverview] = useState(false);
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false);
  const [showTranscriptSearch, setShowTranscriptSearch] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(["archive"]),
  );
  const [sessionActivityRaw, setSessionActivityRaw] = useState<Record<string, Record<string, string>>>({});
  const sessionActivity = useMemo(() => {
    const derived: Record<string, string> = {};
    for (const [issueId, sessions] of Object.entries(sessionActivityRaw)) {
      const values = Object.values(sessions);
      const last = [...values].reverse().find((v: string) => v);
      if (last) derived[issueId] = last;
    }
    return derived;
  }, [sessionActivityRaw]);
  const [liveStats, setLiveStats] = useState<Record<string, LiveSessionStats>>({});
  const [sessionTodos, setSessionTodos] = useState<Record<string, TodoItem[]>>({});
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);
  const pendingBoardRefreshRef = useRef(false);
  const pendingGRef = useRef(false);
  const pendingGTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [expandedCreatePanel, setExpandedCreatePanel] = useState<{ statusId: string; statusName: string; state: Partial<CreateIssueFormState> } | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const routeView = getAppRouteView(window.location.pathname);
    if (routeView) return routeView;
    const stored = localStorage.getItem("kanban-board-view");
    return VIEW_IDS.includes(stored as ViewMode) ? (stored as ViewMode) : "kanban";
  });
  const [dynamicColumnScaling, setDynamicColumnScaling] = useState(false);
  const agentQuestionsCount = useAgentQuestionsCount(activeProjectId);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem("kanban-column-widths") ?? "{}"); } catch { return {}; }
  });
  const resizingRef = useRef<{ colId: string; startX: number; startWidth: number } | null>(null);

  const navigateToViewRoute = useCallback((mode: ViewMode, replace = false) => {
    const nextPath = getViewRoutePath(mode);
    if (window.location.pathname === nextPath) return;
    const nextUrl = `${nextPath}${window.location.search}${window.location.hash}`;
    if (replace) {
      window.history.replaceState(null, "", nextUrl);
    } else {
      window.history.pushState(null, "", nextUrl);
    }
  }, []);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem("kanban-board-view", mode);
    navigateToViewRoute(mode);
  }, [navigateToViewRoute]);

  useEffect(() => {
    function handlePopState() {
      const routeView = getAppRouteView(window.location.pathname);
      if (!routeView) return;
      setViewMode(routeView);
      localStorage.setItem("kanban-board-view", routeView);
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const handleCreatedDateDrilldown = useCallback((dateKey: string) => {
    setCreatedDateFilter(dateKey);
    handleViewModeChange("table");
  }, [handleViewModeChange]);

  const handleColumnResizeStart = useCallback((colId: string, e: React.MouseEvent) => {
    e.preventDefault();
    const colEl = document.getElementById(`column-${colId}`);
    const startWidth = colEl ? colEl.getBoundingClientRect().width : (columnWidths[colId] ?? 288);
    resizingRef.current = { colId, startX: e.clientX, startWidth };

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = ev.clientX - resizingRef.current.startX;
      const newWidth = Math.max(160, Math.min(800, resizingRef.current.startWidth + delta));
      setColumnWidths((prev) => ({ ...prev, [resizingRef.current!.colId]: newWidth }));
    };
    const onMouseUp = () => {
      setColumnWidths((prev) => {
        try { localStorage.setItem("kanban-column-widths", JSON.stringify(prev)); } catch {}
        return prev;
      });
      resizingRef.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [columnWidths]);

  const [autoReview, setAutoReview] = useState(true);
  const [autoMerge, setAutoMerge] = useState(true);
  const [autoMonitor, setAutoMonitor] = useState(false);
  const [autoMonitorInterval, setAutoMonitorInterval] = useState("4");
  const [nudgeAutoStart, setNudgeAutoStart] = useState(false);
  const [nudgeWipLimit, setNudgeWipLimit] = useState("5");
  const [monitorStatus, setMonitorStatus] = useState<MonitorStatus | null>(null);
  const [monitorRunning, setMonitorRunning] = useState(false);
  const [moveToDonePending, setMoveToDonePending] = useState<{ issue: IssueWithStatus; confirm: () => Promise<void> } | null>(null);
  const [pendingWorkspaceIssueIds, setPendingWorkspaceIssueIds] = useState<Set<string>>(new Set());
  const [selectedBoardIssueIds, setSelectedBoardIssueIds] = useState<Set<string>>(new Set());
  const [lastSelectedBoardIssueId, setLastSelectedBoardIssueId] = useState<string | null>(null);
  const [boardBulkUpdating, setBoardBulkUpdating] = useState(false);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [tagsLoaded, setTagsLoaded] = useState(false);

  const refetchBoard = useCallback(async (projectId?: string) => {
    const pid = projectId || activeProjectId;
    if (!pid) return;
    const board = await apiFetch<StatusWithIssues[]>(
      `/api/projects/${pid}/board`,
    );
    setColumns(board);
    columnsRef.current = board;
    // Clear stale live data for issues whose agent is no longer running
    const inactiveIssueIds = new Set<string>();
    for (const col of board) {
      for (const issue of col.issues) {
        const ws = issue.workspaceSummary?.main;
        if (!ws || (ws.status !== "active" && ws.status !== "fixing")) {
          inactiveIssueIds.add(issue.id);
        }
      }
    }
    // Clear pending workspace indicator for issues that now have an active workspace
    setPendingWorkspaceIssueIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      for (const col of board) {
        for (const issue of col.issues) {
          const ws = issue.workspaceSummary?.main;
          if (ws && ws.status !== "closed") next.delete(issue.id);
        }
      }
      return next.size === prev.size ? prev : next;
    });
    if (inactiveIssueIds.size > 0) {
      setLiveStats((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const id of inactiveIssueIds) {
          if (id in next) { delete next[id]; changed = true; }
        }
        return changed ? next : prev;
      });
      setSessionActivityRaw((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const id of inactiveIssueIds) {
          if (id in next) { delete next[id]; changed = true; }
        }
        return changed ? next : prev;
      });
    }
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
            found.issueType !== selectedIssue.issueType ||
            found.statusId !== selectedIssue.statusId ||
            found.statusName !== selectedIssue.statusName ||
            found.updatedAt !== selectedIssue.updatedAt ||
            found.workspaceSummary?.main?.contextTokens !== selectedIssue.workspaceSummary?.main?.contextTokens ||
            found.workspaceSummary?.main?.lastTool !== selectedIssue.workspaceSummary?.main?.lastTool ||
            found.workspaceSummary?.main?.status !== selectedIssue.workspaceSummary?.main?.status) {
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
  }, [refetchBoard, creatingInColumnId]), useCallback((issueId: string, sessionId: string, activity: string) => {
    const isActive = columnsRef.current.some(col =>
      col.issues.some(iss => iss.id === issueId && (iss.workspaceSummary?.main?.status === "active" || iss.workspaceSummary?.main?.status === "fixing"))
    );
    if (!isActive) {
      // Workspace no longer active — clear any stale live data immediately
      setSessionActivityRaw((prev) => {
        if (!(issueId in prev)) return prev;
        const next = { ...prev };
        delete next[issueId];
        setLiveStats((prev2) => {
          if (!(issueId in prev2)) return prev2;
          const next2 = { ...prev2 };
          delete next2[issueId];
          return next2;
        });
        return next;
      });
      return;
    }
    setSessionActivityRaw((prev) => {
      const sessions = { ...(prev[issueId] ?? {}) };
      if (!activity) {
        delete sessions[sessionId];
      } else {
        if (sessions[sessionId] === activity) return prev;
        sessions[sessionId] = activity;
      }
      if (Object.keys(sessions).length === 0) {
        const next = { ...prev };
        delete next[issueId];
        // Also clear liveStats since the agent has finished its turn
        setLiveStats((prev) => {
          if (!(issueId in prev)) return prev;
          const next = { ...prev };
          delete next[issueId];
          return next;
        });
        return next;
      }
      return { ...prev, [issueId]: sessions };
    });
  }, []), useCallback((issueId: string, stats: LiveSessionStats) => {
    // Ignore stats for workspaces that are no longer active (agent finished)
    const isActive = columnsRef.current.some(col =>
      col.issues.some(iss => iss.id === issueId && (iss.workspaceSummary?.main?.status === "active" || iss.workspaceSummary?.main?.status === "fixing"))
    );
    if (!isActive) return;
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
          columnsRef.current = board;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load board");
      }
      // Load preferences independently so they work even if board fails
      try {
        const s = await apiFetch<Record<string, string>>("/api/preferences/settings");
        setDynamicColumnScaling(s.dynamic_column_scaling === "true");
        setAutoReview(s.auto_review !== "false");
        setAutoMerge(s.auto_merge !== "false");
        setAutoMonitor(s.auto_monitor === "true");
        setAutoMonitorInterval(s.auto_monitor_interval ?? "4");
        setNudgeAutoStart(s.nudge_auto_start === "true");
        setNudgeWipLimit(s.nudge_wip_limit ?? "5");
        apiFetch<MonitorStatus>("/api/internal/monitor-status")
          .then((r) => setMonitorStatus(r))
          .catch(() => {});
      } catch {
        // ignore
      }
      setLoading(false);
    }
    load();
  }, [loadProjects]);

  useEffect(() => {
    const t = setInterval(() => {
      apiFetch<MonitorStatus>("/api/internal/monitor-status")
        .then((r) => setMonitorStatus(r))
        .catch(() => {});
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  async function toggleAutoMonitor() {
    const next = !autoMonitor;
    setAutoMonitor(next);
    try {
      await apiFetch("/api/preferences/settings", {
        method: "PUT",
        body: JSON.stringify({ auto_monitor: String(next) }),
      });
      const status = await apiFetch<MonitorStatus>("/api/internal/monitor-status");
      setMonitorStatus(status);
    } catch {
      setAutoMonitor(!next);
    }
  }

  async function handleMonitorRunNow() {
    setMonitorRunning(true);
    try {
      await apiFetch("/api/internal/monitor-run", { method: "POST" });
      const s = await apiFetch<MonitorStatus>("/api/internal/monitor-status");
      setMonitorStatus(s);
    } finally {
      setMonitorRunning(false);
    }
  }

  async function handleIntervalChange(v: string) {
    setAutoMonitorInterval(v);
    await apiFetch("/api/preferences/settings", { method: "PUT", body: JSON.stringify({ auto_monitor_interval: v }) }).catch(() => {});
  }

  async function handleNudgeAutoStartChange(v: boolean) {
    setNudgeAutoStart(v);
    await apiFetch("/api/preferences/settings", { method: "PUT", body: JSON.stringify({ nudge_auto_start: String(v) }) }).catch(() => {});
  }

  async function handleNudgeWipLimitChange(v: string) {
    setNudgeWipLimit(v);
    await apiFetch("/api/preferences/settings", { method: "PUT", body: JSON.stringify({ nudge_wip_limit: v }) }).catch(() => {});
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

  async function handleUnregisterProject(id: string) {
    const project = projects.find((p) => p.id === id);
    await apiFetch(`/api/projects/${id}`, { method: "DELETE" });
    const remaining = projects.filter((p) => p.id !== id);
    if (remaining.length > 0) {
      await handleProjectChange(remaining[0].id);
    } else {
      setActiveProjectId(null);
    }
    await loadProjects();
    showToast(`Removed "${project?.name ?? "project"}"`, "success");
  }

  async function handleCreateIssue(data: CreateIssueRequest & { startWorkspace?: boolean; planMode?: boolean; profile?: ProfileSelection; model?: string; isDirect?: boolean; skillId?: string }) {
    setMutating(true);
    setError(null);
    const { startWorkspace, planMode, profile, model, isDirect, skillId, ...issueData } = data;
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
              baseBranch: isDirect ? undefined : activeProject.defaultBranch ?? undefined,
              isDirect: isDirect || undefined,
              planMode: planMode || undefined,
              profile: profile || undefined,
              model: model || undefined,
              skillId: skillId || undefined,
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
      void board;
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

  const handleBoardDragStart = useCallback((e: React.DragEvent, issue: IssueWithStatus) => {
    (window as unknown as Record<string, unknown>).__dragData = {
      issueId: issue.id,
      sourceStatusId: issue.statusId,
    };
    handleDragStart(e, issue);
  }, []);

  async function handleDrop(targetStatusId: string, sortOrder?: number) {
    try {
      const raw = (window as unknown as Record<string, unknown>).__dragData;
      let issueId: string | undefined;
      let sourceStatusId: string | undefined;

      if (raw && typeof raw === "object") {
        const data = raw as { issueId: string; sourceStatusId: string };
        issueId = data.issueId;
        sourceStatusId = data.sourceStatusId;
      }

      if (!issueId) return;
      if (sourceStatusId === targetStatusId && sortOrder === undefined) return;

      const targetColumn = columns.find((col) => col.id === targetStatusId);
      const isArchiveTarget = targetColumn && ARCHIVE_STATUS_NAMES.has(targetColumn.name);

      if (isArchiveTarget) {
        const issue = columns.flatMap((c) => c.issues).find((i) => i.id === issueId);
        const ws = issue?.workspaceSummary?.main;
        if (issue && ws && ws.status !== "closed") {
          setMoveToDonePending({
            issue,
            confirm: async () => {
              const body: UpdateIssueRequest = { statusId: targetStatusId };
              if (sortOrder !== undefined) body.sortOrder = sortOrder;
              await apiFetch(`/api/issues/${issueId}`, { method: "PATCH", body: JSON.stringify(body) });
              await refetchBoard();
              setMoveToDonePending(null);
            },
          });
          return;
        }
      }

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

  async function handleMoveToNext(issue: IssueWithStatus, nextStatusId: string) {
    try {
      const targetColumn = columns.find((col) => col.id === nextStatusId);
      const isArchiveTarget = targetColumn && ARCHIVE_STATUS_NAMES.has(targetColumn.name);
      if (isArchiveTarget) {
        const ws = issue.workspaceSummary?.main;
        if (ws && ws.status !== "closed") {
          setMoveToDonePending({
            issue,
            confirm: async () => {
              await apiFetch(`/api/issues/${issue.id}`, { method: "PATCH", body: JSON.stringify({ statusId: nextStatusId }) });
              await refetchBoard();
              setMoveToDonePending(null);
            },
          });
          return;
        }
      }
      await apiFetch(`/api/issues/${issue.id}`, { method: "PATCH", body: JSON.stringify({ statusId: nextStatusId }) });
      await refetchBoard();
    } catch {
      showToast("Failed to move issue", "error");
    }
  }

  function moveIssueLocally(issue: IssueWithStatus, targetStatus: StatusWithIssues) {
    const changedAt = new Date().toISOString();
    setColumns((prev) => {
      let foundIssue: IssueWithStatus | undefined;
      const withoutIssue = prev.map((col) => {
        const remaining = col.issues.filter((item) => {
          if (item.id === issue.id) {
            foundIssue = item;
            return false;
          }
          return true;
        });
        return remaining.length === col.issues.length ? col : { ...col, issues: remaining };
      });
      const sourceIssue = foundIssue ?? issue;
      const next = withoutIssue.map((col) => {
        if (col.id !== targetStatus.id) return col;
        const nextSortOrder = col.issues.length > 0
          ? Math.max(...col.issues.map((item) => item.sortOrder)) + 100
          : 0;
        return {
          ...col,
          issues: [
            ...col.issues,
            {
              ...sourceIssue,
              statusId: targetStatus.id,
              statusName: targetStatus.name,
              sortOrder: nextSortOrder,
              updatedAt: changedAt,
              statusChangedAt: changedAt,
            },
          ],
        };
      });
      columnsRef.current = next;
      return next;
    });
  }

  async function handlePromoteBacklogIssue(issue: IssueWithStatus, targetStatus: StatusWithIssues) {
    moveIssueLocally(issue, targetStatus);
    try {
      await apiFetch(`/api/issues/${issue.id}`, {
        method: "PATCH",
        body: JSON.stringify({ statusId: targetStatus.id }),
      });
    } catch (err) {
      await refetchBoard();
      throw err;
    }
  }

  function handleIssueClick(issue: IssueWithStatus) {
    setSelectedIssue(issue);
  }

  function handleBoardIssueClick(issue: IssueWithStatus, event: React.MouseEvent) {
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      event.preventDefault();
      setSelectedIssue(null);
      setSelectedBoardIssueIds((prev) => {
        const next = new Set(prev);
        if (event.shiftKey) {
          const ids = visibleKanbanIssues.map((item) => item.id);
          const anchorIndex = lastSelectedBoardIssueId ? ids.indexOf(lastSelectedBoardIssueId) : -1;
          const currentIndex = ids.indexOf(issue.id);
          if (anchorIndex >= 0 && currentIndex >= 0) {
            const [start, end] = anchorIndex < currentIndex ? [anchorIndex, currentIndex] : [currentIndex, anchorIndex];
            for (const id of ids.slice(start, end + 1)) next.add(id);
          } else {
            next.add(issue.id);
          }
        } else if (next.has(issue.id)) {
          next.delete(issue.id);
        } else {
          next.add(issue.id);
        }
        return next;
      });
      setLastSelectedBoardIssueId(issue.id);
      return;
    }

    if (selectedBoardIssueIds.size > 0) {
      setSelectedBoardIssueIds(new Set());
      setLastSelectedBoardIssueId(null);
    }
    handleIssueClick(issue);
  }

  async function handleBoardBulkUpdate(updates: UpdateIssueRequest, successLabel: string) {
    if (hasArchivedBoardSelection) return;
    const ids = selectedBoardIssues.map((issue) => issue.id);
    if (ids.length === 0) return;
    setBoardBulkUpdating(true);
    try {
      const results = await Promise.allSettled(ids.map((id) =>
        apiFetch(`/api/issues/${id}`, {
          method: "PATCH",
          body: JSON.stringify(updates),
        })
      ));
      const failed = results.filter((result) => result.status === "rejected").length;
      const succeeded = ids.length - failed;
      if (failed === 0) {
        showToast(`${successLabel} for ${succeeded} issue${succeeded !== 1 ? "s" : ""}`, "success");
      } else {
        showToast(`${successLabel} for ${succeeded} issue${succeeded !== 1 ? "s" : ""}; ${failed} failed`, "error");
      }
      setSelectedBoardIssueIds(new Set());
      setLastSelectedBoardIssueId(null);
      await refetchBoard();
    } finally {
      setBoardBulkUpdating(false);
    }
  }

  async function handleBoardBulkAddTag(tagId: string) {
    if (hasArchivedBoardSelection) return;
    const tag = allTags.find((candidate) => candidate.id === tagId);
    const ids = selectedBoardIssues.map((issue) => issue.id);
    if (!tag || ids.length === 0) return;
    setBoardBulkUpdating(true);
    try {
      const results = await Promise.allSettled(ids.map((id) =>
        apiFetch(`/api/issues/${id}/tags`, {
          method: "POST",
          body: JSON.stringify({ tagId }),
        })
      ));
      const failed = results.filter((result) => result.status === "rejected").length;
      const succeeded = ids.length - failed;
      if (failed === 0) {
        showToast(`Added tag "${tag.name}" to ${succeeded} issue${succeeded !== 1 ? "s" : ""}`, "success");
      } else {
        showToast(`Added tag to ${succeeded} issue${succeeded !== 1 ? "s" : ""}; ${failed} failed`, "error");
      }
      setSelectedBoardIssueIds(new Set());
      setLastSelectedBoardIssueId(null);
      await refetchBoard();
    } finally {
      setBoardBulkUpdating(false);
    }
  }

  function handleManageWorkspaces(issue: IssueWithStatus, workspaceId?: string) {
    setSelectedIssue(null);
    setWorkspaceIssue(issue);
    setWorkspaceOpenCreate(false);
    if (workspaceId) {
      setWorkspaceInitial({ workspaceId, sessionId: "" });
    }
  }

  async function handleOpenWorkspaceById(workspaceId: string, issueId: string) {
    let issue = columnsRef.current.flatMap((c) => c.issues).find((i) => i.id === issueId);
    if (!issue) {
      const board = await refetchBoard();
      issue = (board ?? []).flatMap((c) => c.issues).find((i) => i.id === issueId);
    }
    if (!issue) {
      showToast("Issue is not visible on the current board", "error");
      return;
    }
    setSelectedIssue(null);
    setWorkspaceIssue(issue);
    setWorkspaceOpenCreate(false);
    setWorkspaceInitial({ workspaceId, sessionId: "" });
  }

  function handleStartWorkspace(issue: IssueWithStatus) {
    setSelectedIssue(null);
    setWorkspaceIssue(issue);
    setWorkspaceInitial(null);
    setWorkspaceOpenCreate(true);
  }

  const statusFilter = useMemo(
    () => columns.find((col) => col.id === statusFilterId) ?? null,
    [columns, statusFilterId],
  );
  const tagFilter = useMemo(
    () => allTags.find((tag) => tag.id === tagFilterId) ?? null,
    [allTags, tagFilterId],
  );
  const boardViewState: BoardViewState = useMemo(() => ({
    searchQuery,
    showBlocked,
    statusId: statusFilter?.id ?? null,
    statusName: statusFilter?.name ?? null,
    tagId: tagFilter?.id ?? null,
    tagName: tagFilter?.name ?? null,
    sortMode: "rank",
    viewMode,
  }), [searchQuery, showBlocked, statusFilter, tagFilter, viewMode]);
  const boardStatusOptions = useMemo(
    () => columns.map((col) => ({ id: col.id, name: col.name })),
    [columns],
  );
  const boardTagOptions = useMemo(
    () => allTags.map((tag) => ({ id: tag.id, name: tag.name })),
    [allTags],
  );

  useEffect(() => {
    if (statusFilterId && columns.length > 0 && !columns.some((col) => col.id === statusFilterId)) {
      setStatusFilterId(null);
    }
  }, [columns, statusFilterId]);

  useEffect(() => {
    if (tagFilterId && tagsLoaded && !allTags.some((tag) => tag.id === tagFilterId)) {
      setTagFilterId(null);
    }
  }, [allTags, tagFilterId, tagsLoaded]);

  const applyBoardViewState = useCallback((state: BoardViewState) => {
    setSearchQuery(state.searchQuery);
    setShowBlocked(state.showBlocked);
    setStatusFilterId(state.statusId);
    setTagFilterId(state.tagId);
    if (VIEW_IDS.includes(state.viewMode)) {
      handleViewModeChange(state.viewMode);
    }
  }, [handleViewModeChange]);

  // Filter columns by search query and saved-view filters.
  const filteredColumns = useMemo(
    () =>
      columns.map((col) => ({
        ...col,
        issues: col.issues.filter((issue) => {
          if (statusFilterId && issue.statusId !== statusFilterId) {
            return false;
          }
          if (tagFilterId && !issue.tags?.some((tag) => tag.id === tagFilterId)) {
            return false;
          }
          if (showBlocked && !(issue as IssueWithStatus & { isBlocked?: boolean }).isBlocked) {
            return false;
          }
          if (searchQuery) {
            const q = searchQuery.toLowerCase();
            return (
              issue.title.toLowerCase().includes(q) ||
              (issue.description?.toLowerCase().includes(q) ?? false) ||
              (issue.tags?.some((tag) => tag.name.toLowerCase().includes(q)) ?? false)
            );
          }
          return true;
        }),
      })),
    [columns, searchQuery, showBlocked, statusFilterId, tagFilterId],
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

  const backlogColumn = useMemo(
    () => filteredColumns.find((col) => col.name === BACKLOG_STATUS_NAME),
    [filteredColumns],
  );

  const activeColumns = useMemo(
    () =>
      filteredColumns.filter(
        (col) =>
          !ARCHIVE_STATUS_NAMES.has(col.name) &&
          col.name !== BACKLOG_STATUS_NAME &&
          (col.name !== "AI Reviewed" || showAiReviewedColumn),
      ),
    [filteredColumns, showAiReviewedColumn],
  );
  const archiveColumns = useMemo(
    () => filteredColumns.filter((col) => ARCHIVE_STATUS_NAMES.has(col.name)),
    [filteredColumns],
  );
  const archiveExpanded = !collapsedGroups.has("archive");
  const visibleKanbanIssues = useMemo(
    () => [
      ...activeColumns.flatMap((col) => col.issues),
      ...(archiveExpanded ? archiveColumns.flatMap((col) => col.issues) : []),
    ],
    [activeColumns, archiveColumns, archiveExpanded],
  );
  const selectedBoardIssues = useMemo(() => {
    const byId = new Map(visibleKanbanIssues.map((issue) => [issue.id, issue]));
    return [...selectedBoardIssueIds].map((id) => byId.get(id)).filter((issue): issue is IssueWithStatus => !!issue);
  }, [visibleKanbanIssues, selectedBoardIssueIds]);
  const hasArchivedBoardSelection = selectedBoardIssues.some((issue) => ARCHIVE_STATUS_NAMES.has(issue.statusName));

  useEffect(() => {
    if (selectedBoardIssueIds.size === 0) return;
    const visibleIds = new Set(visibleKanbanIssues.map((issue) => issue.id));
    setSelectedBoardIssueIds((prev) => {
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleKanbanIssues, selectedBoardIssueIds.size]);

  async function loadTags(): Promise<SavedViewReference[]> {
    if (tagsLoaded) return allTags;
    try {
      const tags = await apiFetch<Tag[]>("/api/tags");
      setAllTags(tags);
      setTagsLoaded(true);
      return tags;
    } catch {
      showToast("Failed to load tags", "error");
      return allTags;
    }
  }

  useEffect(() => {
    if (selectedBoardIssueIds.size > 0) void loadTags();
  }, [selectedBoardIssueIds.size]);

  const allMentionIssues = useMemo(
    () =>
      columns
        .flatMap((col) => col.issues)
        .map((i) => ({ id: i.id, issueNumber: i.issueNumber, title: i.title })),
    [columns],
  );
  const runQueueForecast = useMemo(
    () => buildRunQueueForecast(columns, nudgeWipLimit),
    [columns, nudgeWipLimit],
  );

  const handleMentionClick = useCallback(
    (issueId: string) => {
      for (const col of columns) {
        const found = col.issues.find((i) => i.id === issueId);
        if (found) {
          setSelectedIssue(found);
          return;
        }
      }
    },
    [columns],
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
    function isTextEntryTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      return target.tagName === "INPUT"
        || target.tagName === "TEXTAREA"
        || target.tagName === "SELECT"
        || target.isContentEditable
        || target.closest("[contenteditable='true']") !== null;
    }

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
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        const input = document.getElementById("search-input") as HTMLInputElement | null;
        if (input) {
          input.focus();
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
        if (showQuickTasks) {
          setShowQuickTasks(false);
          return;
        }
        if (showRunQueueForecast) {
          setShowRunQueueForecast(false);
          return;
        }
        if (showCodemod) {
          setShowCodemod(false);
          return;
        }
        if (searchQuery) {
          setSearchQuery("");
          document.getElementById("search-input")?.blur();
        }
      }
      // "?" to show keyboard shortcuts
      if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        setShowShortcutHelp((prev) => !prev);
      }
      // "g+s" chord to open settings; "g" alone switches to graph view
      if (e.key === "g" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        pendingGRef.current = true;
        if (pendingGTimerRef.current) clearTimeout(pendingGTimerRef.current);
        pendingGTimerRef.current = setTimeout(() => {
          if (pendingGRef.current) {
            pendingGRef.current = false;
            handleViewModeChange("graph");
          }
        }, 400);
        return;
      }
      // complete "g+s" chord or handle standalone "b"/"t" view switches
      if (e.key === "s" && pendingGRef.current && !e.ctrlKey && !e.metaKey && !e.altKey) {
        pendingGRef.current = false;
        if (pendingGTimerRef.current) { clearTimeout(pendingGTimerRef.current); pendingGTimerRef.current = null; }
        e.preventDefault();
        setShowSettings(true);
        return;
      }
      // Plain single-key view shortcuts, derived from the canonical view registry
      // (#116). The `graph` chord ("g", with g+s for settings) is handled above.
      if (SHORTCUT_TO_VIEW[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        handleViewModeChange(SHORTCUT_TO_VIEW[e.key]);
        return;
      }
      // "a" to toggle All Workspaces panel
      if (e.key === "a" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        setShowAllWorkspaces(prev => !prev);
        return;
      }
      // "t" to open Transcript Search
      if (e.key === "t" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        setShowTranscriptSearch(true);
        return;
      }
      // "q" to open Quick Tasks panel
      if (e.key === "q" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        setShowQuickTasks(true);
        return;
      }
      // "x" to open Codemod Factory
      if (e.key === "x" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        setShowCodemod((prev) => !prev);
        return;
      }
      // "V" (shift+v) to trigger voice inbox
      if (e.key === "V" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("voice-inbox-trigger"));
        return;
      }
      // "c" to create issue, "w" to create issue + workspace
      if ((e.key === "c" || e.key === "w") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        const col = activeColumns[0] ?? filteredColumns[0] ?? columns[0];
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
  }, [searchQuery, showCommandPalette, showAllWorkspaces, showTranscriptSearch, showWorktreeOverview, showShortcutHelp, showQuickTasks, showRunQueueForecast, showCodemod, filteredColumns, columns, handleViewModeChange, setShowQuickTasks, setShowSettings]);

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
        const col = activeColumns[0] ?? filteredColumns[0];
        if (col) {
          setCreatingInColumnId(col.id);
        }
      },
    }));

    unregisters.push(registerAction({
      id: "create-issue-with-workspace",
      label: "New Issue + Start Workspace",
      shortcut: "w",
      category: "issue",
      handler: () => {
        const col = activeColumns[0] ?? filteredColumns[0] ?? columns[0];
        if (col) {
          setExpandedCreatePanel({ statusId: col.id, statusName: col.name, state: { startWorkspace: true } });
        }
      },
    }));

    for (const project of projects) {
      const isActive = project.id === activeProjectId;
      unregisters.push(registerAction({
        id: `switch-project-${project.id}`,
        label: `Switch project: ${project.name}${isActive ? " (current)" : ""}`,
        description: isActive ? "Current active project" : "Switch to this project",
        icon: isActive ? "✓" : "⇄",
        category: "navigation",
        handler: () => {
          if (isActive) {
            showToast(`"${project.name}" is already active`, "success");
            return;
          }
          handleProjectChange(project.id);
        },
      }));
    }

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
      id: "search-transcripts",
      label: "Search Transcripts",
      description: "Search agent session transcripts across all workspaces",
      icon: "⏎",
      category: "navigation",
      handler: () => setShowTranscriptSearch(true),
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

    unregisters.push(registerAction({
      id: "open-quick-tasks",
      label: "Open Quick Tasks",
      description: "View installed skills and run custom agent tasks",
      icon: "⚡",
      shortcut: "q",
      category: "board",
      handler: () => setShowQuickTasks(true),
    }));

    unregisters.push(registerAction({
      id: "run-queue-forecast",
      label: "Run Queue Forecast",
      description: "View active-agent capacity and the next likely starts",
      icon: "▥",
      category: "board",
      handler: () => setShowRunQueueForecast(true),
    }));

    unregisters.push(registerAction({
      id: "open-codemod-factory",
      label: "Codemod Factory",
      description: "Describe a refactor in plain English — AI generates a ts-morph codemod",
      icon: "⚙",
      shortcut: "x",
      category: "board",
      handler: () => setShowCodemod(true),
    }));

    // "Switch to <View> View" actions, derived from the canonical view registry
    // (#116) so the palette never drifts out of sync with the toolbar/overlay.
    for (const view of VIEW_REGISTRY) {
      unregisters.push(registerAction({
        id: `view-${view.id}`,
        label: `Switch to ${view.label} View`,
        description: view.paletteDescription,
        icon: view.paletteIcon,
        shortcut: view.shortcut,
        category: "navigation",
        handler: () => handleViewModeChange(view.id),
      }));
    }

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

    // Register Review and Merge actions for issues with eligible workspaces
    const allIssues = columns.flatMap((col) => col.issues);
    for (const issue of allIssues) {
      const ws = issue.workspaceSummary?.main;
      if (!ws) continue;

      if (ws.status === "active" || ws.status === "idle" || ws.status === "reviewing") {
        unregisters.push(registerAction({
          id: `review-workspace-${ws.id}`,
          label: `Review: #${issue.issueNumber} ${issue.title}`,
          description: "Trigger AI code review for this workspace",
          icon: "⑃",
          category: "issue",
          handler: async () => {
            try {
              await apiFetch(`/api/workspaces/${ws.id}/review`, { method: "POST" });
              showToast("Review started", "success");
            } catch {
              showToast("Failed to start review", "error");
            }
          },
        }));
      }

      if (ws.status === "reviewing" || ws.status === "idle") {
        unregisters.push(registerAction({
          id: `merge-workspace-${ws.id}`,
          label: `Merge: #${issue.issueNumber} ${issue.title}`,
          description: "Merge this workspace branch into the base branch",
          icon: "⤵",
          category: "issue",
          handler: async () => {
            try {
              await apiFetch(`/api/workspaces/${ws.id}/merge`, { method: "POST" });
              showToast("Merge started", "success");
            } catch {
              showToast("Failed to merge", "error");
            }
          },
        }));
      }
    }

    return () => unregisters.forEach((fn) => fn());
  }, [columns, filteredColumns, projects, activeProjectId, handleProjectChange]);

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
        <div className="flex items-center justify-center h-96 text-gray-500 dark:text-gray-400">
          <div className="text-center">
            <p className="text-lg font-medium text-gray-700 dark:text-gray-300 mb-2">
              No projects registered
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400">
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
    <MentionProvider value={{ issues: allMentionIssues, onMentionClick: handleMentionClick }}>
    <Layout
      projects={projects}
      activeProjectId={activeProjectId}
      onProjectChange={handleProjectChange}
      onUnregisterProject={handleUnregisterProject}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      onRegisterProject={handleRegisterProject}
      onCreateProject={handleCreateProject}
      onSettingsClick={() => setShowSettings(true)}
      onAllWorkspacesClick={() => setShowAllWorkspaces(true)}
      onWorktreeOverviewClick={() => setShowWorktreeOverview(true)}
      isDark={isDark}
      onThemeToggle={() => setTheme(isDark ? "light" : "dark")}
    >
      {error && (
        <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-200 rounded-md flex items-center justify-between">
          <span className="text-sm text-red-700">{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-400 dark:text-red-500 hover:text-red-600 text-sm"
          >
            Dismiss
          </button>
        </div>
      )}
      {mutating && (
        <div className="fixed bottom-4 right-4 z-50">
          <div className="bg-brand-600 text-white rounded-lg px-4 py-2 flex items-center gap-2 shadow-lg">
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
      <div className="flex flex-col gap-2 p-4 h-full overflow-hidden">
        {/* The board summary (ticket/done/commit badges + progress bar) is irrelevant in
            the Butler chat view — hide it there to give the conversation more vertical room. */}
        {viewMode !== "butler" && (
          <BoardStats
            activeColumns={activeColumns}
            archiveColumns={archiveColumns}
            searchQuery={searchQuery}
            projectId={activeProjectId}
            showBlocked={showBlocked}
            onToggleBlocked={() => setShowBlocked((v) => !v)}
          />
        )}
        {viewMode !== "butler" && (
          <SavedBoardViews
            projectId={activeProjectId}
            currentState={boardViewState}
            statuses={boardStatusOptions}
            tags={boardTagOptions}
            onApply={applyBoardViewState}
            onLoadTags={loadTags}
          />
        )}
        <BoardToolbar
          activeColumns={activeColumns}
          onShowQuickTasks={() => setShowQuickTasks(true)}
          autoMonitor={autoMonitor}
          monitorRunning={monitorRunning}
          onMonitorRunNow={handleMonitorRunNow}
          monitorStatus={monitorStatus}
          onToggleAutoMonitor={toggleAutoMonitor}
          autoMonitorInterval={autoMonitorInterval}
          onIntervalChange={handleIntervalChange}
          nudgeAutoStart={nudgeAutoStart}
          onNudgeAutoStartChange={handleNudgeAutoStartChange}
          nudgeWipLimit={nudgeWipLimit}
          onNudgeWipLimitChange={handleNudgeWipLimitChange}
          columns={columns}
          onOpenWorkspace={handleOpenWorkspaceById}
          viewMode={viewMode}
          onViewModeChange={handleViewModeChange}
          butlerBadgeCount={agentQuestionsCount}
          projectId={activeProjectId}
          onVoiceIssueCreated={() => refetchBoard()}
          onShowMergeQueue={() => setShowMergeQueue(true)}
          mergeQueueCount={columns.flatMap(c => c.issues).filter(i => {
            const ws = i.workspaceSummary?.main;
            return i.statusName === "In Review" && ws && ws.status !== "closed";
          }).length}
          onShowRunQueueForecast={() => setShowRunQueueForecast(true)}
          runQueueOpenSlots={runQueueForecast.openSlots}
        />
        {viewMode === "kanban" && selectedBoardIssues.length > 0 && (
          <div
            className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-xs shadow-sm dark:border-brand-800 dark:bg-brand-950/40"
            data-testid="board-bulk-action-bar"
          >
            <span className="font-medium text-brand-700 dark:text-brand-200">
              {selectedBoardIssues.length} selected
            </span>
            {hasArchivedBoardSelection && (
              <span className="text-amber-700 dark:text-amber-300">
                Bulk edits are unavailable while archived cards are selected.
              </span>
            )}
            <select
              defaultValue=""
              disabled={boardBulkUpdating || hasArchivedBoardSelection}
              onChange={(event) => {
                const statusId = event.target.value;
                const status = columns.find((col) => col.id === statusId);
                event.currentTarget.value = "";
                if (status) void handleBoardBulkUpdate({ statusId }, `Moved to "${status.name}"`);
              }}
              className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-700 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
              aria-label="Bulk move status"
              title={hasArchivedBoardSelection ? "Clear archived selections before bulk editing" : "Move selected cards to status"}
            >
              <option value="">Move status...</option>
              {columns.map((col) => (
                <option key={col.id} value={col.id}>{col.name}</option>
              ))}
            </select>
            <select
              defaultValue=""
              disabled={boardBulkUpdating || hasArchivedBoardSelection}
              onChange={(event) => {
                const priority = event.target.value as (typeof PRIORITY_OPTIONS)[number] | "";
                event.currentTarget.value = "";
                if (priority) void handleBoardBulkUpdate({ priority }, `Set priority to "${PRIORITY_LABEL[priority]}"`);
              }}
              className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-700 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
              aria-label="Bulk set priority"
              title={hasArchivedBoardSelection ? "Clear archived selections before bulk editing" : "Set priority on selected cards"}
            >
              <option value="">Set priority...</option>
              {PRIORITY_OPTIONS.map((priority) => (
                <option key={priority} value={priority}>{PRIORITY_LABEL[priority]}</option>
              ))}
            </select>
            <select
              defaultValue=""
              disabled={boardBulkUpdating || hasArchivedBoardSelection || allTags.length === 0}
              onFocus={() => void loadTags()}
              onChange={(event) => {
                const tagId = event.target.value;
                event.currentTarget.value = "";
                if (tagId) void handleBoardBulkAddTag(tagId);
              }}
              className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-700 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
              aria-label="Bulk add tag"
              title={hasArchivedBoardSelection ? "Clear archived selections before bulk editing" : "Add a tag to selected cards"}
            >
              <option value="">Add tag...</option>
              {allTags.map((tag) => (
                <option key={tag.id} value={tag.id}>{tag.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                setSelectedBoardIssueIds(new Set());
                setLastSelectedBoardIssueId(null);
              }}
              className="rounded px-2 py-1 text-brand-600 underline-offset-2 hover:underline dark:text-brand-300"
            >
              Clear
            </button>
          </div>
        )}
        {viewMode === "graph" && activeProjectId ? (
          <div className="flex-1 min-h-0">
            <BoardErrorBoundary columnName="Graph View">
              <GraphView
                columns={columns}
                projectId={activeProjectId}
                onIssueClick={handleIssueClick}
                searchQuery={searchQuery}
              />
            </BoardErrorBoundary>
          </div>
        ) : null}
        {viewMode === "table" && (
          <BoardErrorBoundary columnName="Table View">
            <TableView
              columns={columns}
              onIssueClick={handleIssueClick}
              searchQuery={searchQuery}
              onRefresh={() => refetchBoard()}
              createdDateFilter={createdDateFilter}
              onClearCreatedDateFilter={() => setCreatedDateFilter(null)}
            />
          </BoardErrorBoundary>
        )}
        {viewMode === "agents" && (
          <BoardErrorBoundary columnName="Agents View">
            <AgentGrid
              columns={columns}
              liveActivity={sessionActivity}
              liveStats={liveStats}
              sessionTodos={sessionTodos}
              onIssueClick={handleIssueClick}
              onWorkspaceClick={handleManageWorkspaces}
              onGoToBoard={() => setViewMode("kanban")}
            />
          </BoardErrorBoundary>
        )}
        {viewMode === "timeline" && (
          <BoardErrorBoundary columnName="Timeline View">
            <TimelineView
              columns={columns}
              onIssueClick={handleIssueClick}
              searchQuery={searchQuery}
            />
          </BoardErrorBoundary>
        )}
        {viewMode === "metrics" && (
          <BoardErrorBoundary columnName="Metrics View">
            <MetricsView
              columns={columns}
              projectId={activeProjectId}
              onIssueClick={handleIssueClick}
              onCreatedDateClick={handleCreatedDateDrilldown}
            />
          </BoardErrorBoundary>
        )}
        {viewMode === "quality-metrics" && activeProjectId && (
          <BoardErrorBoundary columnName="Quality Metrics View">
            <QualityMetricsView projectId={activeProjectId} />
          </BoardErrorBoundary>
        )}
        {viewMode === "butler" && activeProjectId && (
          <BoardErrorBoundary columnName="Butler View">
            <ButlerView
              projectId={activeProjectId}
              columns={columns}
              liveActivity={sessionActivity}
              liveStats={liveStats}
              onIssueClick={handleIssueClick}
              onExit={() => handleViewModeChange("kanban")}
            />
          </BoardErrorBoundary>
        )}
        {viewMode === "workflows" && activeProjectId && (
          <BoardErrorBoundary columnName="Workflows View">
            <WorkflowsView projectId={activeProjectId} onOpenWorkspace={handleOpenWorkspaceById} />
          </BoardErrorBoundary>
        )}
        {viewMode === "workflow-analytics" && activeProjectId && (
          <BoardErrorBoundary columnName="Workflow Analytics">
            <WorkflowAnalyticsDashboard projectId={activeProjectId} />
          </BoardErrorBoundary>
        )}
        {viewMode === "insights" && activeProjectId && (
          <BoardErrorBoundary columnName="Insights View">
            <InsightsPanel
              projectId={activeProjectId}
              onSessionClick={(sessionId, workspaceId, issueId) => {
                const issue = columns.flatMap(c => c.issues).find(i => i.id === issueId);
                if (issue) {
                  setSelectedIssue(null);
                  setWorkspaceIssue(issue);
                  setWorkspaceOpenCreate(false);
                  setWorkspaceInitial({ workspaceId, sessionId });
                }
              }}
            />
          </BoardErrorBoundary>
        )}
        {viewMode === "digest" && activeProjectId && (
          <BoardErrorBoundary columnName="Digest View">
            <DigestView
              projectId={activeProjectId}
              onIssueClick={(issueId) => {
                const issue = columns.flatMap(c => c.issues).find(i => i.id === issueId);
                if (issue) handleIssueClick(issue);
              }}
            />
          </BoardErrorBoundary>
        )}
        {viewMode === "focus" && activeProjectId && (
          <BoardErrorBoundary columnName="Focus View">
            <FocusView
              projectId={activeProjectId}
              onIssueClick={(issueId) => {
                const issue = columns.flatMap(c => c.issues).find(i => i.id === issueId);
                if (issue) handleIssueClick(issue);
              }}
            />
          </BoardErrorBoundary>
        )}
        {viewMode === "strategy" && activeProjectId && (
          <BoardErrorBoundary columnName="Strategic Targets">
            <StrategyTargetsView
              columns={columns}
              projectId={activeProjectId}
              onIssueClick={handleIssueClick}
              searchQuery={searchQuery}
            />
          </BoardErrorBoundary>
        )}
        {viewMode === "swimlane" && (
          <BoardErrorBoundary columnName="Swimlane View">
            <SwimlaneView
              columns={columns}
              onIssueClick={handleIssueClick}
              searchQuery={searchQuery}
            />
          </BoardErrorBoundary>
        )}
        {viewMode === "flaky-tests" && activeProjectId && (
          <BoardErrorBoundary columnName="Flaky Tests">
            <FlakyTestsPanel projectId={activeProjectId} />
          </BoardErrorBoundary>
        )}
        {viewMode === "monitor-history" && activeProjectId && (
          <BoardErrorBoundary columnName="Monitor History">
            <MonitorCycleHistoryPanel projectId={activeProjectId} />
          </BoardErrorBoundary>
        )}
        {viewMode === "backlog" && (
          <BoardErrorBoundary columnName="Backlog View">
            <BacklogView
              backlogColumn={backlogColumn}
              activeColumns={activeColumns}
              projectId={activeProjectId}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              sessionActivity={sessionActivity}
              liveStats={liveStats}
              sessionTodos={sessionTodos}
              pendingWorkspaceIssueIds={pendingWorkspaceIssueIds}
              canStartWorkspace={canStartWorkspace}
              onIssueClick={handleIssueClick}
              onWorkspaceClick={handleManageWorkspaces}
              onStartWorkspace={handleStartWorkspace}
              onDragStart={handleBoardDragStart}
              onDrop={handleDrop}
              onPromoteToTodo={handlePromoteBacklogIssue}
              onCreateIssue={handleCreateIssue}
              onExpandCreate={(statusId, statusName, state) => setExpandedCreatePanel({ statusId, statusName, state })}
            />
          </BoardErrorBoundary>
        )}
        {viewMode === "kanban" && (
          <BoardKanbanView
            activeColumns={activeColumns}
            archiveColumns={archiveColumns}
            allColumns={columns}
            projectId={activeProjectId}
            columnWidths={columnWidths}
            dynamicColumnScaling={dynamicColumnScaling}
            creatingInColumnId={creatingInColumnId}
            searchQuery={searchQuery}
            sessionActivity={sessionActivity}
            liveStats={liveStats}
            sessionTodos={sessionTodos}
            pendingWorkspaceIssueIds={pendingWorkspaceIssueIds}
            collapsedArchive={collapsedGroups.has("archive")}
            canStartWorkspace={canStartWorkspace}
            onToggleArchive={() => toggleGroup("archive")}
            onCreateClick={setCreatingInColumnId}
            onCreateCancel={() => setCreatingInColumnId(null)}
            onIssueClick={handleBoardIssueClick}
            onWorkspaceClick={handleManageWorkspaces}
            onStartWorkspace={handleStartWorkspace}
            onDragStart={handleBoardDragStart}
            onDrop={handleDrop}
            onMoveToNext={handleMoveToNext}
            onColumnResizeStart={handleColumnResizeStart}
            onColumnResizeReset={(colId) => setColumnWidths((prev) => {
              const next = { ...prev };
              delete next[colId];
              try { localStorage.setItem("kanban-column-widths", JSON.stringify(next)); } catch {}
              return next;
            })}
            onCreateIssue={handleCreateIssue}
            onExpandCreate={(statusId, statusName, state) => setExpandedCreatePanel({ statusId, statusName, state })}
            selectedIssueIds={selectedBoardIssueIds}
          />
        )}
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
          key={`${workspaceIssue.id}:${workspaceInitial?.workspaceId ?? "new"}:${workspaceOpenCreate ? "create" : "view"}`}
          issue={workspaceIssue}
          project={activeProject ?? null}
          onClose={() => { setWorkspaceIssue(null); setWorkspaceInitial(null); setWorkspaceOpenCreate(false); }}
          onWorkspaceChange={() => refetchBoard()}
          onWorkspaceCreating={(issueId) => setPendingWorkspaceIssueIds((prev) => new Set([...prev, issueId]))}
          initialWorkspaceId={workspaceInitial?.workspaceId}
          initialSessionId={workspaceInitial?.sessionId}
          initialShowCreate={workspaceOpenCreate}
        />
      )}
      <ApprovalDialog
        requests={approvalRequests}
        onResolve={(id) => setApprovalRequests((prev) => prev.filter((r) => r.id !== id))}
      />
      {moveToDonePending && (
        <MoveToDoneDialog
          issue={moveToDonePending.issue}
          onConfirm={moveToDonePending.confirm}
          onCancel={() => setMoveToDonePending(null)}
        />
      )}
      <ToastContainer />
      {showSettings && (
        <SettingsPanel onClose={() => {
          setShowSettings(false);
          apiFetch<Record<string, string>>("/api/preferences/settings")
            .then(s => {
              setAutoReview(s.auto_review !== "false");
              setAutoMerge(s.auto_merge !== "false");
              setAutoMonitor(s.auto_monitor === "true");
              setAutoMonitorInterval(s.auto_monitor_interval ?? "4");
              setNudgeAutoStart(s.nudge_auto_start === "true");
              setNudgeWipLimit(s.nudge_wip_limit ?? "5");
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
      {showCodemod && (
        <CodemodPanel
          onClose={() => setShowCodemod(false)}
          activeProjectId={activeProjectId}
        />
      )}
      {showAllWorkspaces && (
        <AllWorkspacesPanel
          columns={columns}
          activeProjectId={activeProjectId ?? null}
          onClose={() => setShowAllWorkspaces(false)}
          onIssueClick={(issue) => {
            setSelectedIssue(issue);
            setShowAllWorkspaces(false);
          }}
          onRefresh={() => refetchBoard()}
        />
      )}
      {showTranscriptSearch && activeProjectId && (
        <TranscriptSearchPanel
          projectId={activeProjectId}
          onClose={() => setShowTranscriptSearch(false)}
          onNavigateToWorkspace={(issueId, workspaceId, sessionId) => {
            setShowTranscriptSearch(false);
            const issue = columnsRef.current.flatMap((c) => c.issues).find((i) => i.id === issueId);
            if (issue) {
              setSelectedIssue(null);
              setWorkspaceIssue(issue);
              setWorkspaceOpenCreate(false);
              setWorkspaceInitial({ workspaceId, sessionId });
            } else {
              showToast("Issue not found on current board — try refreshing", "error");
            }
          }}
        />
      )}
      {showMergeQueue && activeProjectId && (
        <MergeQueuePanel
          columns={columns}
          projectId={activeProjectId}
          onClose={() => setShowMergeQueue(false)}
          onIssueClick={(issue) => {
            setSelectedIssue(issue);
            setShowMergeQueue(false);
          }}
          onMerged={() => {
            refetchBoard();
          }}
        />
      )}
      {showRunQueueForecast && (
        <RunQueueForecastPanel
          columns={columns}
          activeTarget={nudgeWipLimit}
          onClose={() => setShowRunQueueForecast(false)}
          onIssueClick={(issue) => {
            setSelectedIssue(issue);
            setShowRunQueueForecast(false);
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
        <ShortcutHelp onClose={() => setShowShortcutHelp(false)} currentView={viewMode} />
      )}
      {expandedCreatePanel && activeProjectId && (
        <CreateIssuePanel
          projectId={activeProjectId}
          statusId={expandedCreatePanel.statusId}
          statusName={expandedCreatePanel.statusName}
          availableStatuses={[
            ...(backlogColumn ? [{ id: backlogColumn.id, name: backlogColumn.name }] : []),
            ...activeColumns.map((c) => ({ id: c.id, name: c.name })),
          ]}
          initialState={expandedCreatePanel.state}
          onSubmit={handleCreateIssue}
          onClose={() => setExpandedCreatePanel(null)}
          canStartWorkspace={canStartWorkspace}
        />
      )}
    </Layout>
    </MentionProvider>
  );
}
