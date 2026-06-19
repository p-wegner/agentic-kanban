import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layout } from "../components/Layout.js";
import { useTheme } from "../hooks/useTheme.js";
import { useAgentQuestionsCount } from "../components/AgentQuestionsPanel.js";
import { useBoardLiveHandlers } from "../hooks/useBoardLiveHandlers.js";
import { useBoardPanelNavigation } from "../hooks/useBoardPanelNavigation.js";
import { useProjectManagement } from "../hooks/useProjectManagement.js";
import { useBoardFilters } from "../hooks/useBoardFilters.js";
import { useBoardIssueActions } from "../hooks/useBoardIssueActions.js";
import { useBoardMiscHandlers } from "../hooks/useBoardMiscHandlers.js";
import { BoardPageView } from "../components/BoardPageView.js";
import { deferUntilIdle } from "../lib/boardCardSnapshot.js";
import { useBoardRefetch } from "../hooks/useBoardRefetch.js";
import type { CreateIssueFormState } from "../components/CreateIssueForm.js";
import { SkeletonBoard } from "../components/SkeletonBoard.js";
import { showToast } from "../components/Toast.js";
import { apiFetch } from "../lib/api.js";
import { setBoardDragData, getBoardDragData } from "../lib/dragData.js";
import { matchesBoardFilters } from "../lib/boardFiltering.js";
import { reconcileSelectedIssue } from "../lib/selectedIssueSync.js";
import { applyLocalReorder, moveIssueToStatus } from "../lib/issueMoveHelpers.js";
import { createQuickUpdateHandlers } from "../lib/issueQuickUpdates.js";
import { useColumnResize } from "../lib/columnResizeHandler.js";
import { type LiveSessionStats, type TodoItem, type ApprovalRequest } from "../lib/useBoardEvents.js";
import { useActivityNotifications, type NotificationEvent } from "../hooks/useActivityNotifications.js";
import { buildRunQueueForecast } from "../components/RunQueueForecastPanel.js";
import { useBoardPageRoute } from "./useBoardPageRoute.js";
import { useBoardPreferences } from "../hooks/useBoardPreferences.js";
import { useBoardPanels } from "../hooks/useBoardPanels.js";
import { useBoardNavigation } from "../hooks/useBoardNavigation.js";
import { useBoardBulkSelection } from "../hooks/useBoardBulkSelection.js";
import { useBoardIssueMovement } from "../hooks/useBoardIssueMovement.js";
import { useBoardKeyboardShortcuts } from "../hooks/useBoardKeyboardShortcuts.js";
import { useAgentLiveTicker } from "../hooks/useAgentLiveTicker.js";
import type {
  DependencyInfo,
  IssueWithStatus,
  MilestoneResponse,
  StatusWithIssues,
  UpdateIssueRequest,
} from "@agentic-kanban/shared";
import type { BoardViewState, SavedViewReference } from "../lib/boardSavedViews.js";


interface Project {
  id: string;
  name: string;
  repoPath: string;
  repoName: string;
  defaultBranch: string | null;
  remoteUrl: string | null;
  setupScript?: string | null;
  setupEnabled?: boolean;
  setupBlocking?: boolean;
  symlinkEnabled?: boolean;
  symlinkDirs?: string | null;
  archivedAt?: string | null;
  activeWorkspaceCount?: number;
}

interface Tag {
  id: string;
  name: string;
  color: string | null;
}

const ARCHIVE_STATUS_NAMES = new Set(["Done", "Cancelled"]);
const BACKLOG_STATUS_NAME = "Backlog";

/**
 * Run `cb` once the browser is idle (`requestIdleCallback`, with a setTimeout
 * fallback). Returns a cancel function. Used to keep non-critical mount
 * fetches out of the first-paint request window.
 */
export function BoardPage() {
  const { theme: _theme, setTheme, isDark } = useTheme();
  // Warm the overlay-panels chunk shortly after the board paints. It is lazy (keeps it
  // off the initial bundle) but hosts the event-driven ApprovalDialog, so prefetching
  // on idle means an incoming agent-approval request never waits on a cold chunk fetch.
  useEffect(() => {
    const warm = () => { void import("../components/BoardOverlayPanels.js"); };
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (ric) { const id = ric(warm); return () => (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(id); }
    const t = setTimeout(warm, 1500);
    return () => clearTimeout(t);
  }, []);
  const [columns, setColumns] = useState<StatusWithIssues[]>([]);
  const columnsRef = useRef<StatusWithIssues[]>([]);
  const [loading, setLoading] = useState(true);
  const [switchingProject, setSwitchingProject] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [archivedProjects, setArchivedProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const notifications = useActivityNotifications(activeProjectId);
  const { addBoardEvent: addNotificationBoardEvent, addApprovalEvent: addNotificationApprovalEvent } = notifications;
  const [creatingInColumnId, setCreatingInColumnId] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<IssueWithStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const [workspaceIssue, setWorkspaceIssue] = useState<IssueWithStatus | null>(null);
  const [workspaceInitial, setWorkspaceInitial] = useState<{ workspaceId: string; sessionId: string } | null>(null);
  const [workspaceInitialDiff, setWorkspaceInitialDiff] = useState(false);
  const [workspaceOpenCreate, setWorkspaceOpenCreate] = useState(false);
  // A prompt to seed the butler with when entering its view via "Chat about this
  // ticket" (#838). Cleared once ButlerView has consumed it.
  const [butlerInitialPrompt, setButlerInitialPrompt] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [focusMode, setFocusMode] = useState(() => {
    try { return sessionStorage.getItem("board-focus-mode") === "1"; } catch { return false; }
  });
  const [statusFilterId, setStatusFilterId] = useState<string | null>(null);
  const {
    activeTagIds,
    setActiveTagIds,
    issueTypeFilter,
    priorityFilter,
    handleIssueTypeFilterChange,
    handlePriorityFilterChange,
    handleTagFilterToggle,
    handleClearTagFilter,
    handleSetTagFilterIds,
  } = useBoardFilters(activeProjectId);
  const [milestoneFilterId, setMilestoneFilterId] = useState<string | null>(null);
  const [milestones, setMilestones] = useState<MilestoneResponse[]>([]);
  const [createdDateFilter, setCreatedDateFilter] = useState<string | null>(null);
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
  const loadProjectsRef = useRef<() => Promise<string | undefined>>(async () => undefined);
  const [expandedCreatePanel, setExpandedCreatePanel] = useState<{ statusId: string; statusName: string; state: Partial<CreateIssueFormState> } | null>(null);
  const [keyboardCursorIssueId, setKeyboardCursorIssueId] = useState<string | null>(null);
  const keyboardCursorIssueIdRef = useRef<string | null>(null);
  keyboardCursorIssueIdRef.current = keyboardCursorIssueId;

  const {
    viewMode,
    graphFocusIssueId,
    setGraphFocusIssueId,
    handleViewModeChange,
  } = useBoardPageRoute();

  const [activeAgentsTarget, setActiveAgentsTarget] = useState<number | undefined>(undefined);

  // Extracted hooks
  const prefs = useBoardPreferences(activeProjectId);
  const panels = useBoardPanels();
  const tickerEntries = useAgentLiveTicker(columns, sessionActivity, panels.showLiveActivityTicker);
  const agentQuestionsCount = useAgentQuestionsCount(activeProjectId);
  const { columnWidths, handleColumnResizeStart, resetColumnWidth } = useColumnResize();

  const [moveToDonePending, setMoveToDonePending] = useState<{ issue: IssueWithStatus; confirm: () => Promise<void> } | null>(null);
  const [dependencyImpactPending, setDependencyImpactPending] = useState<{
    issue: IssueWithStatus;
    toStatusId: string;
    toStatusName: string;
    dependencies: DependencyInfo["dependencies"];
    confirm: () => Promise<void>;
  } | null>(null);
  const [pendingIssueIds, setPendingIssueIds] = useState<Set<string>>(new Set());
  const [pendingWorkspaceIssueIds, setPendingWorkspaceIssueIds] = useState<Set<string>>(new Set());
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [tagsLoaded, setTagsLoaded] = useState(false);

  const { refetchBoard, scheduleRefetch } = useBoardRefetch({
    activeProjectId,
    columnsRef,
    setColumns,
    setPendingWorkspaceIssueIds,
    setLiveStats,
    setSessionActivityRaw,
  });

  // Keep selectedIssue in sync with board data (F6 stale data fix). The pure
  // reconcile logic (incl. the stripped-description edge case) lives in
  // lib/selectedIssueSync.ts and is unit-tested there.
  useEffect(() => {
    if (!selectedIssue) return;
    const result = reconcileSelectedIssue(columns, selectedIssue);
    if (result.changed) setSelectedIssue(result.next);
  }, [columns, selectedIssue]);
  // Real-time board updates via WebSocket (handlers + subscription)
  useBoardLiveHandlers({
    activeProjectId,
    columnsRef,
    loadProjectsRef,
    pendingBoardRefreshRef,
    refetchBoard,
    scheduleRefetch,
    setColumns,
    creatingInColumnId,
    setSessionActivityRaw,
    setLiveStats,
    setSessionTodos,
    setApprovalRequests,
    addNotificationBoardEvent,
    addNotificationApprovalEvent,
  });

  // Process pending board refresh when create form closes
  useEffect(() => {
    if (!creatingInColumnId && pendingBoardRefreshRef.current) {
      pendingBoardRefreshRef.current = false;
      refetchBoard();
    }
  }, [creatingInColumnId, refetchBoard]);

  const loadArchivedProjects = useCallback(async () => {
    try {
      const all = await apiFetch<Project[]>("/api/projects?includeArchived=true");
      setArchivedProjects(all.filter((p) => p.archivedAt));
    } catch {
      // non-fatal — archived list is supplementary
    }
  }, []);

  const loadProjects = useCallback(async () => {
    const projs = await apiFetch<Project[]>("/api/projects");
    setProjects(projs);
    void loadArchivedProjects();
    if (projs.length === 0) {
      setActiveProjectId(null);
      return undefined;
    }
    try {
      const pref = await apiFetch<{ projectId: string | null }>("/api/preferences/active-project");
      if (pref.projectId && projs.some((p) => p.id === pref.projectId)) {
        setActiveProjectId(pref.projectId);
        return pref.projectId;
      }
    } catch {
      // fall back to first project
    }
    const firstId = projs[0].id;
    setActiveProjectId(firstId);
    return firstId;
  }, [loadArchivedProjects]);
  loadProjectsRef.current = loadProjects;

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

          const params = new URLSearchParams(window.location.search);
          const issueParam = params.get("issue");
          if (issueParam != null) {
            const issueNumber = parseInt(issueParam, 10);
            if (!isNaN(issueNumber)) {
              const found = board.flatMap((c) => c.issues).find((i) => i.issueNumber === issueNumber);
              if (found) setSelectedIssue(found);
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load board");
      }
      setLoading(false);
    }
    load();
  }, [loadProjects]);

  useEffect(() => {
    if (!activeProjectId) return;
    // Deferred to idle: only feeds the drag-to-agent-slot capacity guard, so
    // it must not compete with the board fetch in the first-paint window.
    return deferUntilIdle(() => {
      apiFetch<{ policy: { activeAgentsTarget: number } }>(`/api/projects/${activeProjectId}/sprint-capacity`)
        .then((plan) => setActiveAgentsTarget(plan.policy.activeAgentsTarget))
        .catch(() => {});
    });
  }, [activeProjectId]);


  const {
    handleProjectChange,
    handleRegisterProject,
    handleCreateProject,
    handleUnregisterProject,
    handleArchiveProject,
    handleUnarchiveProject,
  } = useProjectManagement({
    activeProjectId,
    projects,
    archivedProjects,
    setActiveProjectId,
    setColumns,
    columnsRef,
    setSelectedIssue,
    setWorkspaceIssue,
    setSwitchingProject,
    refetchBoard,
    loadProjects,
  });


  const { handleQuickPriorityChange, handleQuickAddTag, handleQuickRemoveTag, handleQuickTogglePinned } =
    createQuickUpdateHandlers({ columnsRef, setColumns, allTags, refetchBoard });

  const {
    swimlaneDimension,
    handleSwimlaneChange,
    handleBoardDragStart,
    handleDrop,
    handleDropWithLane,
    handleColumnReorder,
    handleMoveToNext,
    handlePromoteBacklogIssue,
  } = useBoardIssueMovement({
    columns,
    columnsRef,
    setColumns,
    activeProjectId,
    refetchBoard,
    scheduleRefetch,
    setMoveToDonePending,
    setDependencyImpactPending,
  });

  const {
    handleIssueClick,
    handleManageWorkspaces,
    handleChatAboutTicket,
    handleOpenDiff,
    handleOpenWorkspaceById,
    handleStartWorkspace,
  } = useBoardPanelNavigation({
    pendingIssueIds,
    columnsRef,
    refetchBoard,
    setSelectedIssue,
    setKeyboardCursorIssueId,
    setWorkspaceIssue,
    setWorkspaceOpenCreate,
    setWorkspaceInitialDiff,
    setWorkspaceInitial,
    setButlerInitialPrompt,
    handleViewModeChange,
  });


  const [showBlocked, setShowBlocked] = useState(false);
  const [showStaleOnly, setShowStaleOnly] = useState(false);

  const boardViewState: BoardViewState = useMemo(() => {
    const tagIds = [...activeTagIds].sort((a, b) => a.localeCompare(b));
    const tagNames = tagIds
      .map((tagId) => allTags.find((tag) => tag.id === tagId)?.name)
      .filter((name): name is string => !!name);
    return {
      tagIds,
      tagNames,
      issueType: issueTypeFilter,
      priority: priorityFilter,
    };
  }, [activeTagIds, allTags, issueTypeFilter, priorityFilter]);
  const boardStatusOptions = useMemo(
    () => columns.map((col) => ({ id: col.id, name: col.name })),
    [columns],
  );
  const boardTagOptions = useMemo(
    () => allTags.map((tag) => ({ id: tag.id, name: tag.name })),
    [allTags],
  );
  const loadSavedViewTags = useCallback(async (): Promise<SavedViewReference[]> => {
    if (tagsLoaded) return boardTagOptions;
    const tags = await apiFetch<Tag[]>("/api/tags");
    setAllTags(tags);
    setTagsLoaded(true);
    return tags.map((tag) => ({ id: tag.id, name: tag.name }));
  }, [boardTagOptions, tagsLoaded]);

  useEffect(() => {
    if (statusFilterId && columns.length > 0 && !columns.some((col) => col.id === statusFilterId)) {
      setStatusFilterId(null);
    }
  }, [columns, statusFilterId]);

  useEffect(() => {
    if (activeTagIds.size > 0 && tagsLoaded) {
      const validIds = new Set([...activeTagIds].filter((id) => allTags.some((t) => t.id === id)));
      if (validIds.size !== activeTagIds.size) {
        setActiveTagIds(validIds);
      }
    }
  }, [allTags, activeTagIds, tagsLoaded]);

  useEffect(() => {
    if (!activeProjectId || tagsLoaded) return;
    apiFetch<Tag[]>("/api/tags")
      .then((tags) => { setAllTags(tags); setTagsLoaded(true); })
      .catch(() => {});
  }, [activeProjectId, tagsLoaded]);

  useEffect(() => {
    if (!activeProjectId) return;
    // Deferred to idle: milestones feed the filter menu / detail panel, not
    // the first board paint.
    return deferUntilIdle(() => {
      apiFetch<MilestoneResponse[]>(`/api/projects/${activeProjectId}/milestones`)
        .then((ms) => setMilestones(ms))
        .catch(() => {});
    });
  }, [activeProjectId]);

  const applyBoardViewState = useCallback((state: BoardViewState) => {
    handleSetTagFilterIds(state.tagIds);
    handleIssueTypeFilterChange(state.issueType);
    handlePriorityFilterChange(state.priority);
  }, [handleIssueTypeFilterChange, handlePriorityFilterChange, handleSetTagFilterIds]);

  const handleMilestoneOverviewClick = useCallback((milestoneId: string) => {
    setMilestoneFilterId(milestoneId);
    handleViewModeChange("kanban");
  }, [handleViewModeChange]);

  const filterOptions = useMemo(() => ({
    focusMode,
    statusFilterId,
    activeTagIds,
    milestoneFilterId,
    issueTypeFilter,
    priorityFilter,
    showBlocked,
    showStaleOnly,
    searchQuery,
  }), [focusMode, statusFilterId, activeTagIds, milestoneFilterId, issueTypeFilter, priorityFilter, showBlocked, showStaleOnly, searchQuery]);

  const filteredColumns = useMemo(
    () =>
      columns.map((col) => ({
        ...col,
        issues: col.issues.filter((issue) => matchesBoardFilters(issue, filterOptions)),
      })),
    [columns, filterOptions],
  );

  const showAiReviewedColumn = useMemo(
    () =>
      columns.some((col) => col.name === "AI Reviewed" && col.issues.length > 0) ||
      (prefs.autoReview && !prefs.autoMerge),
    [columns, prefs.autoReview, prefs.autoMerge],
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
          (col.name !== "AI Reviewed" || showAiReviewedColumn) &&
          !prefs.hiddenColumns.has(col.name),
      ),
    [filteredColumns, showAiReviewedColumn, prefs.hiddenColumns],
  );
  const archiveColumns = useMemo(
    () => filteredColumns.filter((col) => ARCHIVE_STATUS_NAMES.has(col.name)),
    [filteredColumns],
  );
  const visibilityColumns = useMemo(
    () => columns.filter((col) => !ARCHIVE_STATUS_NAMES.has(col.name) && col.name !== BACKLOG_STATUS_NAME),
    [columns],
  );
  const archiveExpanded = !collapsedGroups.has("archive");
  const visibleKanbanIssues = useMemo(
    () => [
      ...activeColumns.flatMap((col) => col.issues),
      ...(archiveExpanded ? archiveColumns.flatMap((col) => col.issues) : []),
    ],
    [activeColumns, archiveColumns, archiveExpanded],
  );

  const bulk = useBoardBulkSelection(visibleKanbanIssues, allTags, refetchBoard);

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
    if (bulk.selectedBoardIssueIds.size > 0) void loadTags();
  }, [bulk.selectedBoardIssueIds.size]);

  const allMentionIssues = useMemo(
    () =>
      columns
        .flatMap((col) => col.issues)
        .map((i) => ({ id: i.id, issueNumber: i.issueNumber, title: i.title })),
    [columns],
  );
  const runQueueForecast = useMemo(
    () => buildRunQueueForecast(columns, prefs.nudgeWipLimit),
    [columns, prefs.nudgeWipLimit],
  );

  const { openIssueById, navigateTrail, trailControls, ticketTrail } = useBoardNavigation(columns, setSelectedIssue);

  const { handleDuplicateIssue, handleMentionClick, toggleGroup, handleCreatedDateDrilldown } = useBoardMiscHandlers({
    selectedIssue, keyboardCursorIssueId, ticketTrail, openIssueById,
    handleViewModeChange, refetchBoard, setCollapsedGroups, setCreatedDateFilter,
  });

  // Keyboard shortcuts
  useBoardKeyboardShortcuts(
    {
      columnsRef,
      columns,
      filteredColumns,
      activeColumns,
      archiveColumns,
      archiveExpanded,
      viewMode,
      keyboardCursorIssueId,
      keyboardCursorIssueIdRef,
      searchQuery,
      selectedIssue,
      projects,
      activeProjectId,
    },
    {
      handleIssueClick,
      handleViewModeChange,
      handleProjectChange,
      setSearchQuery,
      setKeyboardCursorIssueId,
      setSelectedIssue,
      setFocusMode,
      setExpandedCreatePanel,
      setCreatingInColumnId,
      panels,
    },
  );


  if (loading) {
    return (
      <Layout onRegisterProject={handleRegisterProject} onCreateProject={handleCreateProject}>
        <SkeletonBoard />
      </Layout>
    );
  }

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
  const { handleCreateIssue, handleUpdateIssue, handleDeleteIssue, handleDropOnAgentSlot } = useBoardIssueActions({
    activeProject: activeProject ?? null, activeAgentsTarget, columns, columnsRef, pendingBoardRefreshRef,
    refetchBoard, setColumns, setCreatingInColumnId, setError, setExpandedCreatePanel,
    setMutating, setPendingIssueIds, setPendingWorkspaceIssueIds, setSelectedIssue,
    setWorkspaceInitial, setWorkspaceIssue, setWorkspaceOpenCreate,
  });
  const canStartWorkspace = !!activeProject?.repoPath;

  function handleNotificationEventClick(event: NotificationEvent) {
    if (event.issueId) {
      const found = columns.flatMap((col) => col.issues).find((iss) => iss.id === event.issueId);
      if (found) {
        setSelectedIssue(null);
        if (event.workspaceId) {
          setWorkspaceIssue(found);
        } else {
          setSelectedIssue(found);
        }
        return;
      }
    }
    // Fallback: show all workspaces panel
    panels.setShowAllWorkspaces(true);
  }

  const handleBoardIssueClick = (issue: IssueWithStatus, event: React.MouseEvent) => {
    if (pendingIssueIds.has(issue.id)) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      event.preventDefault();
      setSelectedIssue(null);
      if (event.shiftKey) {
        bulk.rangeSelect(issue.id);
      } else {
        bulk.toggleSelection(issue.id);
      }
      return;
    }
    if (bulk.selectedBoardIssueIds.size > 0) {
      bulk.clearSelection();
    }
    handleIssueClick(issue);
  };
  return (
    <BoardPageView
      {...{
        activeAgentsTarget,
        activeColumns,
        activeProject,
        activeProjectId,
        activeTagIds,
        agentQuestionsCount,
        allMentionIssues,
        allTags,
        applyBoardViewState,
        approvalRequests,
        archiveColumns,
        archivedProjects,
        backlogColumn,
        boardStatusOptions,
        boardTagOptions,
        boardViewState,
        bulk,
        butlerInitialPrompt,
        canStartWorkspace,
        collapsedGroups,
        columnWidths,
        columns,
        columnsRef,
        createdDateFilter,
        creatingInColumnId,
        dependencyImpactPending,
        error,
        expandedCreatePanel,
        focusMode,
        graphFocusIssueId,
        handleArchiveProject,
        handleBoardDragStart,
        handleBoardIssueClick,
        handleChatAboutTicket,
        handleClearTagFilter,
        handleColumnReorder,
        handleColumnResizeStart,
        handleCreateIssue,
        handleCreateProject,
        handleCreatedDateDrilldown,
        handleDeleteIssue,
        handleDrop,
        handleDropOnAgentSlot,
        handleDropWithLane,
        handleDuplicateIssue,
        handleIssueClick,
        handleIssueTypeFilterChange,
        handleManageWorkspaces,
        handleMentionClick,
        handleMilestoneOverviewClick,
        handleMoveToNext,
        handleNotificationEventClick,
        handleOpenDiff,
        handleOpenWorkspaceById,
        handlePriorityFilterChange,
        handleProjectChange,
        handlePromoteBacklogIssue,
        handleQuickAddTag,
        handleQuickPriorityChange,
        handleQuickRemoveTag,
        handleQuickTogglePinned,
        handleRegisterProject,
        handleStartWorkspace,
        handleSwimlaneChange,
        handleTagFilterToggle,
        handleUnarchiveProject,
        handleUnregisterProject,
        handleUpdateIssue,
        handleViewModeChange,
        isDark,
        issueTypeFilter,
        keyboardCursorIssueId,
        liveStats,
        loadSavedViewTags,
        loadTags,
        milestoneFilterId,
        milestones,
        moveToDonePending,
        mutating,
        notifications,
        openIssueById,
        panels,
        pendingIssueIds,
        pendingWorkspaceIssueIds,
        prefs,
        priorityFilter,
        projects,
        refetchBoard,
        resetColumnWidth,
        runQueueForecast,
        searchQuery,
        selectedIssue,
        sessionActivity,
        sessionTodos,
        setApprovalRequests,
        setButlerInitialPrompt,
        setCreatedDateFilter,
        setCreatingInColumnId,
        setDependencyImpactPending,
        setError,
        setExpandedCreatePanel,
        setFocusMode,
        setGraphFocusIssueId,
        setMilestoneFilterId,
        setMoveToDonePending,
        setPendingWorkspaceIssueIds,
        setSearchQuery,
        setSelectedIssue,
        setShowBlocked,
        setShowStaleOnly,
        setStatusFilterId,
        setTheme,
        setWorkspaceInitial,
        setWorkspaceInitialDiff,
        setWorkspaceIssue,
        setWorkspaceOpenCreate,
        showBlocked,
        showStaleOnly,
        statusFilterId,
        swimlaneDimension,
        switchingProject,
        tickerEntries,
        toggleGroup,
        trailControls,
        viewMode,
        visibilityColumns,
        workspaceInitial,
        workspaceInitialDiff,
        workspaceIssue,
        workspaceOpenCreate,
      }}
    />
  );
}
