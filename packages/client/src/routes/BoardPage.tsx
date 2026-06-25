import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "../components/Layout.js";
import { useTheme } from "../hooks/useTheme.js";
import { useAgentQuestionsCount } from "../components/AgentQuestionsPanel.js";
import { useBoardPanelNavigation } from "../hooks/useBoardPanelNavigation.js";
import { useProjectManagement } from "../hooks/useProjectManagement.js";
import { useBoardFilters } from "../hooks/useBoardFilters.js";
import { createBoardIssueActions } from "../hooks/createBoardIssueActions.js";
import { useBoardMiscHandlers } from "../hooks/useBoardMiscHandlers.js";
import { BoardPageView } from "../components/BoardPageView.js";
import type { CreateIssueFormState } from "../components/CreateIssueForm.js";
import { SkeletonBoard } from "../components/SkeletonBoard.js";
import { showToast } from "../components/Toast.js";
import { matchesBoardFilters } from "../lib/boardFiltering.js";
import { reconcileSelectedIssue } from "../lib/selectedIssueSync.js";
import { createQuickUpdateHandlers } from "../lib/issueQuickUpdates.js";
import { useColumnResize } from "../lib/columnResizeHandler.js";
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
import { useBoardRealtimeController } from "../hooks/useBoardRealtimeController.js";
import { useBoardDataController } from "../hooks/useBoardDataController.js";
import {
  boardQueryKeys,
  fetchTags,
} from "../hooks/useBoardDataQueries.js";
import { invalidateClientSurface, subscribeClientInvalidations } from "../lib/clientInvalidation.js";
import { useBoardSelectionStore } from "../stores/boardSelectionStore.js";
import type {
  DependencyInfo,
  IssueWithStatus,
} from "@agentic-kanban/shared";
import type { BoardViewState, SavedViewReference } from "../lib/boardSavedViews.js";


export interface Project {
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

export interface Tag {
  id: string;
  name: string;
  color: string | null;
}

/** Pending "move to Done" confirmation (issue + the deferred mutation). */
export type MoveToDonePending = { issue: IssueWithStatus; confirm: () => Promise<void> } | null;

/** Pending dependency-impact confirmation when moving an issue across statuses. */
export type DependencyImpactPending = {
  issue: IssueWithStatus;
  toStatusId: string;
  toStatusName: string;
  dependencies: DependencyInfo["dependencies"];
  confirm: () => Promise<void>;
} | null;

/** Inline create-issue panel expanded under a column. */
export type ExpandedCreatePanel = { statusId: string; statusName: string; state: Partial<CreateIssueFormState> } | null;

/** Workspace panel deep-link target (open a specific workspace/session). */
export type WorkspaceInitial = { workspaceId: string; sessionId: string } | null;

const ARCHIVE_STATUS_NAMES = new Set(["Done", "Cancelled"]);
const BACKLOG_STATUS_NAME = "Backlog";

/**
 * Run `cb` once the browser is idle (`requestIdleCallback`, with a setTimeout
 * fallback). Returns a cancel function. Used to keep non-critical mount
 * fetches out of the first-paint request window.
 */
export function BoardPage() {
  const queryClient = useQueryClient();
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
  const [creatingInColumnId, setCreatingInColumnId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Selection slice (#905) — moved off BoardPage into the board store. BoardPage
  // reads the bits it still needs (the reconcile effect, the few handlers below)
  // via selectors/actions; every other consumer reads the store directly.
  const selectedIssue = useBoardSelectionStore((s) => s.selectedIssue);
  const setSelectedIssue = useBoardSelectionStore((s) => s.setSelectedIssue);
  const setWorkspaceIssue = useBoardSelectionStore((s) => s.setWorkspaceIssue);
  const {
    activeAgentsTarget,
    activeProjectId,
    allTags,
    archivedProjects,
    columns,
    columnsRef,
    loading,
    milestones,
    projects,
    setActiveProjectId,
    setColumns,
    setSwitchingProject,
    switchingProject,
    tagsLoaded,
  } = useBoardDataController({ setError });
  const notifications = useActivityNotifications(activeProjectId);
  const { addBoardEvent: addNotificationBoardEvent, addApprovalEvent: addNotificationApprovalEvent } = notifications;
  const [mutating, setMutating] = useState(false);
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
  const [createdDateFilter, setCreatedDateFilter] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(["archive"]),
  );
  const loadProjectsRef = useRef<() => Promise<string | undefined>>(() => Promise.resolve(undefined));
  const [expandedCreatePanel, setExpandedCreatePanel] = useState<ExpandedCreatePanel>(null);
  const [keyboardCursorIssueId, setKeyboardCursorIssueId] = useState<string | null>(null);
  const keyboardCursorIssueIdRef = useRef<string | null>(null);
  keyboardCursorIssueIdRef.current = keyboardCursorIssueId;

  const {
    viewMode,
    graphFocusIssueId,
    setGraphFocusIssueId,
    handleViewModeChange,
  } = useBoardPageRoute();

  // Extracted hooks
  const prefs = useBoardPreferences(activeProjectId);
  const panels = useBoardPanels();
  const agentQuestionsCount = useAgentQuestionsCount(activeProjectId);
  const { columnWidths, handleColumnResizeStart, resetColumnWidth } = useColumnResize();

  const [moveToDonePending, setMoveToDonePending] = useState<MoveToDonePending>(null);
  const [dependencyImpactPending, setDependencyImpactPending] = useState<DependencyImpactPending>(null);
  const [pendingIssueIds, setPendingIssueIds] = useState<Set<string>>(new Set());
  const [pendingWorkspaceIssueIds, setPendingWorkspaceIssueIds] = useState<Set<string>>(new Set());

  const {
    approvalRequests,
    liveStats,
    pendingBoardRefreshRef,
    refetchBoard,
    scheduleRefetch,
    sessionActivity,
    sessionTodos,
    setApprovalRequests,
  } = useBoardRealtimeController({
    activeProjectId,
    columnsRef,
    creatingInColumnId,
    loadProjectsRef,
    addNotificationApprovalEvent,
    addNotificationBoardEvent,
    setColumns,
    setPendingWorkspaceIssueIds,
  });
  useEffect(() => subscribeClientInvalidations((event) => {
    if (event.surface !== "workspace" && event.surface !== "board" && event.surface !== "issue-detail") return;
    if (!activeProjectId || event.projectId !== activeProjectId) return;
    scheduleRefetch();
  }), [activeProjectId, scheduleRefetch]);
  const tickerEntries = useAgentLiveTicker(columns, sessionActivity, panels.showLiveActivityTicker);

  // Keep selectedIssue in sync with board data (F6 stale data fix). The pure
  // reconcile logic (incl. the stripped-description edge case) lives in
  // lib/selectedIssueSync.ts and is unit-tested there.
  useEffect(() => {
    if (!selectedIssue) return;
    const result = reconcileSelectedIssue(columns, selectedIssue);
    if (result.changed) setSelectedIssue(result.next);
  }, [columns, selectedIssue, setSelectedIssue]);
  const loadProjects = useCallback(async () => {
    await invalidateClientSurface(queryClient, { surface: "projects" });
    return activeProjectId ?? undefined;
  }, [activeProjectId, queryClient]);
  loadProjectsRef.current = loadProjects;

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
    setKeyboardCursorIssueId,
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
    const tags = await queryClient.fetchQuery({
      queryKey: boardQueryKeys.tags,
      queryFn: fetchTags,
    });
    return tags.map((tag) => ({ id: tag.id, name: tag.name }));
  }, [boardTagOptions, queryClient, tagsLoaded]);

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
      const tags = await queryClient.fetchQuery({
        queryKey: boardQueryKeys.tags,
        queryFn: fetchTags,
      });
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

  const { openIssueById, trailControls, ticketTrail } = useBoardNavigation(columns);

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
      projects,
      activeProjectId,
    },
    {
      handleIssueClick,
      handleViewModeChange,
      handleProjectChange,
      setSearchQuery,
      setKeyboardCursorIssueId,
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
  const { handleCreateIssue, handleUpdateIssue, handleDeleteIssue, handleDropOnAgentSlot } = createBoardIssueActions({
    activeProject: activeProject ?? null, activeAgentsTarget, columns, columnsRef, pendingBoardRefreshRef,
    refetchBoard, setColumns, setCreatingInColumnId, setError, setExpandedCreatePanel,
    setMutating, setPendingIssueIds, setPendingWorkspaceIssueIds,
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
      board={{
        activeAgentsTarget,
        activeColumns,
        allMentionIssues,
        allTags,
        archiveColumns,
        backlogColumn,
        boardStatusOptions,
        boardTagOptions,
        boardViewState,
        bulk,
        canStartWorkspace,
        collapsedGroups,
        columnWidths,
        columns,
        columnsRef,
        creatingInColumnId,
        expandedCreatePanel,
        keyboardCursorIssueId,
        milestones,
        pendingIssueIds,
        pendingWorkspaceIssueIds,
        runQueueForecast,
        visibilityColumns,
      }}
      chrome={{
        dependencyImpactPending,
        error,
        graphFocusIssueId,
        isDark,
        moveToDonePending,
        mutating,
        panels,
        prefs,
        setCreatingInColumnId,
        setDependencyImpactPending,
        setError,
        setExpandedCreatePanel,
        setGraphFocusIssueId,
        setMoveToDonePending,
        setPendingWorkspaceIssueIds,
        setTheme,
      }}
      commands={{
        handleBoardDragStart,
        handleBoardIssueClick,
        handleChatAboutTicket,
        handleColumnReorder,
        handleColumnResizeStart,
        handleCreateIssue,
        handleCreatedDateDrilldown,
        handleDeleteIssue,
        handleDrop,
        handleDropOnAgentSlot,
        handleDropWithLane,
        handleDuplicateIssue,
        handleIssueClick,
        handleManageWorkspaces,
        handleMentionClick,
        handleMoveToNext,
        handleOpenDiff,
        handleOpenWorkspaceById,
        handlePromoteBacklogIssue,
        handleQuickAddTag,
        handleQuickPriorityChange,
        handleQuickRemoveTag,
        handleQuickTogglePinned,
        handleStartWorkspace,
        handleSwimlaneChange,
        handleUpdateIssue,
        handleViewModeChange,
        openIssueById,
        refetchBoard,
        resetColumnWidth,
        swimlaneDimension,
        toggleGroup,
        trailControls,
        viewMode,
      }}
      filters={{
        activeTagIds,
        applyBoardViewState,
        createdDateFilter,
        focusMode,
        handleClearTagFilter,
        handleIssueTypeFilterChange,
        handleMilestoneOverviewClick,
        handlePriorityFilterChange,
        handleTagFilterToggle,
        issueTypeFilter,
        loadSavedViewTags,
        loadTags,
        milestoneFilterId,
        priorityFilter,
        searchQuery,
        setCreatedDateFilter,
        setFocusMode,
        setMilestoneFilterId,
        setSearchQuery,
        setShowBlocked,
        setShowStaleOnly,
        setStatusFilterId,
        showBlocked,
        showStaleOnly,
        statusFilterId,
      }}
      project={{
        activeProject,
        activeProjectId,
        archivedProjects,
        handleArchiveProject,
        handleCreateProject,
        handleProjectChange,
        handleRegisterProject,
        handleUnarchiveProject,
        handleUnregisterProject,
        projects,
        switchingProject,
      }}
      realtime={{
        agentQuestionsCount,
        approvalRequests,
        handleNotificationEventClick,
        liveStats,
        notifications,
        sessionActivity,
        sessionTodos,
        setApprovalRequests,
        tickerEntries,
      }}
      workspace={{
        butlerInitialPrompt,
        setButlerInitialPrompt,
      }}
    />
  );
}
