import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layout } from "../components/Layout.js";
import { useTheme } from "../hooks/useTheme.js";
import { GraphView } from "../components/GraphView.js";
import { TableView } from "../components/TableView.js";
import { AgentGrid } from "../components/AgentGrid.js";
import { TimelineView } from "../components/TimelineView.js";
import { BoardErrorBoundary } from "../components/BoardErrorBoundary.js";
import { BoardKanbanView } from "../components/BoardKanbanView.js";
import { BoardStats } from "../components/BoardStats.js";
import { BoardToolbar, type ViewMode } from "../components/BoardToolbar.js";
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
import { QuickTasksPanel } from "../components/QuickTasksPanel.js";
import type { MonitorStatus } from "../components/MonitorPopover.js";
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

const ARCHIVE_STATUS_NAMES = new Set(["Done", "Cancelled"]);
const BACKLOG_STATUS_NAME = "Backlog";


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
  const [showBlocked, setShowBlocked] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showQuickTasks, setShowQuickTasks] = useState(false);
  const [showWorktreeOverview, setShowWorktreeOverview] = useState(false);
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false);
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
  const [viewMode, setViewMode] = useState<ViewMode>("kanban");
  const [dynamicColumnScaling, setDynamicColumnScaling] = useState(false);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem("kanban-column-widths") ?? "{}"); } catch { return {}; }
  });
  const resizingRef = useRef<{ colId: string; startX: number; startWidth: number } | null>(null);

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
    if (!autoMonitor) return;
    const t = setInterval(() => {
      apiFetch<MonitorStatus>("/api/internal/monitor-status")
        .then((r) => setMonitorStatus(r))
        .catch(() => {});
    }, 30_000);
    return () => clearInterval(t);
  }, [autoMonitor]);

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

  async function handleCreateIssue(data: CreateIssueRequest & { startWorkspace?: boolean; planMode?: boolean; profile?: ProfileSelection; isDirect?: boolean; skillId?: string }) {
    setMutating(true);
    setError(null);
    const { startWorkspace, planMode, profile, isDirect, skillId, ...issueData } = data;
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

  function handleIssueClick(issue: IssueWithStatus) {
    setSelectedIssue(issue);
  }

  function handleManageWorkspaces(issue: IssueWithStatus, workspaceId?: string) {
    setSelectedIssue(null);
    setWorkspaceIssue(issue);
    setWorkspaceOpenCreate(false);
    if (workspaceId) {
      setWorkspaceInitial({ workspaceId, sessionId: "" });
    }
  }

  function handleStartWorkspace(issue: IssueWithStatus) {
    setSelectedIssue(null);
    setWorkspaceIssue(issue);
    setWorkspaceInitial(null);
    setWorkspaceOpenCreate(true);
  }

  // Filter columns by search query
  const filteredColumns = useMemo(
    () =>
      columns.map((col) => ({
        ...col,
        issues: col.issues.filter((issue) => {
          if (showBlocked && !(issue as IssueWithStatus & { isBlocked?: boolean }).isBlocked) {
            return false;
          }
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
    [columns, searchQuery, showBlocked],
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

  const allMentionIssues = useMemo(
    () =>
      columns
        .flatMap((col) => col.issues)
        .map((i) => ({ id: i.id, issueNumber: i.issueNumber, title: i.title })),
    [columns],
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
      // "g+s" chord to open settings; "g" alone switches to graph view
      if (e.key === "g" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
        e.preventDefault();
        pendingGRef.current = true;
        if (pendingGTimerRef.current) clearTimeout(pendingGTimerRef.current);
        pendingGTimerRef.current = setTimeout(() => {
          if (pendingGRef.current) {
            pendingGRef.current = false;
            setViewMode("graph");
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
      if ((e.key === "b" || e.key === "t" || e.key === "l" || e.key === "f") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
        e.preventDefault();
        if (e.key === "b") setViewMode("kanban");
        else if (e.key === "t") setViewMode("table");
        else if (e.key === "l") setViewMode("agents");
        else if (e.key === "f") setViewMode("timeline");
        return;
      }
      // "a" to toggle All Workspaces panel
      if (e.key === "a" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
        e.preventDefault();
        setShowAllWorkspaces(prev => !prev);
        return;
      }
      // "q" to open Quick Tasks panel
      if (e.key === "q" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
        e.preventDefault();
        setShowQuickTasks(true);
        return;
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
  }, [searchQuery, showCommandPalette, showAllWorkspaces, showWorktreeOverview, showShortcutHelp, showQuickTasks, filteredColumns, columns, setViewMode, setShowQuickTasks, setShowSettings]);

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

    for (const project of projects) {
      const isActive = project.id === activeProjectId;
      unregisters.push(registerAction({
        id: `switch-project-${project.id}`,
        label: `Switch to: ${project.name}`,
        description: isActive ? "Active project" : "Switch to this project",
        icon: isActive ? "✓" : "⇄",
        category: "navigation",
        handler: () => handleProjectChange(project.id),
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
      id: "view-board",
      label: "Switch to Board View",
      description: "Show kanban board columns",
      icon: "⊟",
      shortcut: "b",
      category: "navigation",
      handler: () => setViewMode("kanban"),
    }));

    unregisters.push(registerAction({
      id: "view-graph",
      label: "Switch to Graph View",
      description: "Show dependency graph",
      icon: "⬡",
      shortcut: "g",
      category: "navigation",
      handler: () => setViewMode("graph"),
    }));

    unregisters.push(registerAction({
      id: "view-agents",
      label: "Switch to Agents View",
      description: "Live grid of all active agent sessions",
      icon: "⚡",
      shortcut: "l",
      category: "navigation",
      handler: () => setViewMode("agents"),
    }));

    unregisters.push(registerAction({
      id: "view-table",
      label: "Switch to Table View",
      description: "Show flat table list",
      icon: "☰",
      shortcut: "t",
      category: "navigation",
      handler: () => setViewMode("table"),
    }));

    unregisters.push(registerAction({
      id: "view-timeline",
      label: "Switch to Timeline View",
      description: "Show issues on a chronological timeline",
      icon: "⏱",
      shortcut: "f",
      category: "navigation",
      handler: () => setViewMode("timeline"),
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
      <div className="flex flex-col gap-2 p-4 h-full overflow-hidden">
        <BoardStats
          activeColumns={activeColumns}
          archiveColumns={archiveColumns}
          searchQuery={searchQuery}
          projectId={activeProjectId}
          showBlocked={showBlocked}
          onToggleBlocked={() => setShowBlocked((v) => !v)}
        />
        <BoardToolbar
          backlogColumn={backlogColumn}
          activeColumns={activeColumns}
          searchQuery={searchQuery}
          onIssueClick={handleIssueClick}
          onBacklogMoved={() => refetchBoard()}
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
          onOpenWorkspace={(workspaceId, issueId) => {
            const issue = columns.flatMap(c => c.issues).find(i => i.id === issueId);
            if (issue) setWorkspaceIssue(issue);
            setWorkspaceInitial({ workspaceId, sessionId: "" });
          }}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
        />
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
            onIssueClick={handleIssueClick}
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
    </MentionProvider>
  );
}
