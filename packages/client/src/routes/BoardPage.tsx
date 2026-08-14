import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "../components/Layout.js";
import { useTheme } from "../hooks/useTheme.js";
import { useAgentQuestionsCount } from "../components/AgentQuestionsPanel.js";
import { useBoardPanelNavigation } from "../hooks/useBoardPanelNavigation.js";
import { useProjectManagement } from "../hooks/useProjectManagement.js";
import { createBoardIssueActions } from "../hooks/createBoardIssueActions.js";
import { useBoardMiscHandlers } from "../hooks/useBoardMiscHandlers.js";
import { BoardPageView } from "../components/BoardPageView.js";
import type { CreateIssueFormState } from "../components/CreateIssueForm.js";
import { SkeletonBoard } from "../components/SkeletonBoard.js";
import { showToast } from "../components/Toast.js";
import { apiFetch } from "../lib/api.js";
import { fetchProjectRepos } from "../lib/projectReposQuery.js";
import { matchesBoardFilters } from "../lib/boardFiltering.js";
import { reconcileSelectedIssue } from "../lib/selectedIssueSync.js";
import { createQuickUpdateHandlers } from "../lib/issueQuickUpdates.js";
import { useColumnResize } from "../lib/columnResizeHandler.js";
import { useActivityNotifications, type NotificationEvent } from "../hooks/useActivityNotifications.js";
import { buildRunQueueForecast } from "../components/RunQueueForecastPanel.js";
import { useBoardPageRoute } from "./useBoardPageRoute.js";
import { markProgrammaticNavigation, navigationBurst } from "./boardRouteSync.js";
import type { IssuePanel } from "../lib/appRoutes.js";

/**
 * How long a FOCUS_ISSUE request whose issue is not on the board YET is held
 * while the project it belongs to loads. Bounded so a link naming an issue that
 * never arrives cannot open a panel long after the click.
 */
const FOCUS_ISSUE_HOLD_MS = 15_000;
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
import { useBoardFilterStore, boardFilterActions } from "../stores/boardFilterStore.js";
import { useBoardBulkSelectionStore } from "../stores/boardBulkSelectionStore.js";
import { usePluginViewStore } from "../stores/pluginViewStore.js";
import { SELECT_PROJECT_EVENT, type SelectProjectDetail, FOCUS_ISSUE_EVENT, type FocusIssueDetail } from "../lib/navigateView.js";
import type {
  DependencyInfo,
  IssueWithStatus,
} from "@agentic-kanban/shared";
import { GLOBAL_BUTLER_PROJECT_ID } from "@agentic-kanban/shared";
import { ButlerView } from "../components/ButlerView.js";
import type { SavedViewReference } from "../lib/boardSavedViews.js";
import { resolveVisibleView } from "../lib/viewRegistry.js";
import { useHiddenViews } from "../hooks/useHiddenViews.js";


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
  // The SECOND issue-bearing panel (#446 follow-up). It was invisible to the
  // URL: opening a diff/workspace drawer left the address bar on /board, so the
  // state was unshareable and unreloadable.
  const workspaceIssue = useBoardSelectionStore((s) => s.workspaceIssue);
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
  const { addBoardEvent: addNotificationBoardEvent, addApprovalEvent: addNotificationApprovalEvent, addPluginGateEvent: addNotificationPluginGateEvent } = notifications;
  const [mutating, setMutating] = useState(false);
  // A prompt to seed the butler with when entering its view via "Chat about this
  // ticket" (#838). Cleared once ButlerView has consumed it.
  const [butlerInitialPrompt, setButlerInitialPrompt] = useState<string | null>(null);
  // When no project is registered, the user can still open a GLOBAL butler to import/create one.
  const [showGlobalButler, setShowGlobalButler] = useState(false);
  // Filter slice (#958) — filter state lives in the board filter store. This
  // container only reads what it needs to compute `filteredColumns` (below)
  // and to run the validation/hydration effects; consumers (toolbar, filter
  // menu, kanban/backlog views, cards) subscribe to the store directly.
  const searchQuery = useBoardFilterStore((s) => s.searchQuery);
  const focusMode = useBoardFilterStore((s) => s.focusMode);
  const statusFilterId = useBoardFilterStore((s) => s.statusFilterId);
  const milestoneFilterId = useBoardFilterStore((s) => s.milestoneFilterId);
  const showBlocked = useBoardFilterStore((s) => s.showBlocked);
  const showStaleOnly = useBoardFilterStore((s) => s.showStaleOnly);
  const activeTagIds = useBoardFilterStore((s) => s.activeTagIds);
  const issueTypeFilter = useBoardFilterStore((s) => s.issueTypeFilter);
  const priorityFilter = useBoardFilterStore((s) => s.priorityFilter);
  const hydrateProjectFilters = useBoardFilterStore((s) => s.hydrateProjectFilters);
  // Load the per-project persisted filters (type/priority/tags) on switch.
  useEffect(() => {
    hydrateProjectFilters(activeProjectId);
  }, [activeProjectId, hydrateProjectFilters]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(["archive"]),
  );
  const loadProjectsRef = useRef<() => Promise<string | undefined>>(() => Promise.resolve(undefined));
  const [expandedCreatePanel, setExpandedCreatePanel] = useState<ExpandedCreatePanel>(null);

  // Extracted hooks
  const prefs = useBoardPreferences(activeProjectId);
  const panels = useBoardPanels();
  const agentQuestionsCount = useAgentQuestionsCount(activeProjectId);
  const { columnWidths, handleColumnResizeStart, resetColumnWidth } = useColumnResize();

  const [moveToDonePending, setMoveToDonePending] = useState<MoveToDonePending>(null);
  const [dependencyImpactPending, setDependencyImpactPending] = useState<DependencyImpactPending>(null);
  // Bulk-selection slice (#958) — pending indicator sets live in the store;
  // only the click-guard below still reads them here.
  const pendingIssueIds = useBoardBulkSelectionStore((s) => s.pendingIssueIds);

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
    columns,
    columnsRef,
    creatingInColumnId,
    loadProjectsRef,
    addNotificationApprovalEvent,
    addNotificationBoardEvent,
    addNotificationPluginGateEvent,
    setColumns,
  });
  useEffect(() => {
    // Workspace/board live events change which agents are running, which drives the
    // project selector's "active agents" badge (activeWorkspaceCount). That count rides
    // on the projects query, which is otherwise only refreshed on explicit project-mgmt
    // actions — so without a refresh here it stays stale (showing agents after they've
    // stopped). But /api/projects is one of the slowest endpoints, and an undebounced
    // invalidation per mutation event cancels and restarts the in-flight fetch on every
    // merge-cascade event, so it can never settle. Leading + trailing 30s throttle, and
    // never cancel an in-flight refetch — the badge only needs eventual freshness.
    let throttleTimer: number | null = null;
    let trailingPending = false;
    const invalidateProjects = () =>
      queryClient.invalidateQueries({ queryKey: boardQueryKeys.projects }, { cancelRefetch: false });
    const unsubscribe = subscribeClientInvalidations((event) => {
      if (event.surface !== "workspace" && event.surface !== "board" && event.surface !== "issue-detail") return;
      if (!activeProjectId || event.projectId !== activeProjectId) return;
      if (event.surface === "workspace" || event.surface === "board") {
        if (throttleTimer == null) {
          void invalidateProjects();
          throttleTimer = window.setTimeout(() => {
            throttleTimer = null;
            if (trailingPending) {
              trailingPending = false;
              void invalidateProjects();
            }
          }, 30_000);
        } else {
          trailingPending = true;
        }
      }
      scheduleRefetch();
    });
    return () => {
      unsubscribe();
      if (throttleTimer != null) window.clearTimeout(throttleTimer);
    };
  }, [activeProjectId, scheduleRefetch, queryClient]);
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

  // Issue deep links (#446) resolve against `columnsRef`, not `columns` — same
  // reason as the FOCUS_ISSUE handler below: a link applied right after a
  // project switch must read the CURRENT board.
  // The panel handlers are created below (they need handleViewModeChange, which
  // the route hook returns), so the route hook reaches them through a ref.
  const openWorkspacePanelRef = useRef<(issue: IssueWithStatus, workspaceId?: string) => void>(() => {});
  const openIssueNumber = useCallback((issueNumber: number, panel: IssuePanel = "issue"): boolean => {
    const issue = columnsRef.current
      .flatMap((col) => col.issues)
      .find((i) => i.issueNumber === issueNumber);
    if (!issue) return false;
    if (panel === "workspace") {
      openWorkspacePanelRef.current(issue);
    } else {
      setWorkspaceIssue(null);
      setSelectedIssue(issue);
    }
    return true;
  }, [columnsRef, setSelectedIssue, setWorkspaceIssue]);
  // Back past an `/issue/<n>` entry closes whichever panel that entry opened.
  const closeSelectedIssue = useCallback(() => {
    setSelectedIssue(null);
    setWorkspaceIssue(null);
  }, [setSelectedIssue, setWorkspaceIssue]);

  // The URL owns (project, view, open issue) (#446): inbound deep links win over
  // the stored view preference, every state change is reflected in the address
  // bar, and back/forward restores all three.
  const {
    viewMode: routedViewMode,
    graphFocusIssueId,
    setGraphFocusIssueId,
    handleViewModeChange,
  } = useBoardPageRoute({
    projects,
    activeProjectId,
    // The workspace drawer wins when both are set (the handlers clear the other,
    // so this is only a tie-break) — it is the panel actually on top.
    selectedIssueNumber: workspaceIssue?.issueNumber ?? selectedIssue?.issueNumber ?? null,
    openPanel: workspaceIssue ? "workspace" : selectedIssue ? "issue" : null,
    columns,
    onSelectProject: handleProjectChange,
    onOpenIssueNumber: openIssueNumber,
    onCloseIssue: closeSelectedIssue,
  });

  // #233 — a view hidden for this project must not remain the RENDERED one. It can still be the
  // routed one (a deep link, or a stored preference from before it was hidden), and rendering it
  // would leave the toolbar with no active tab and the user with no way back short of editing the
  // URL. Falls back to the board; the URL is left alone so a link keeps working once the view is
  // un-hidden again.
  const { hidden: hiddenViews } = useHiddenViews(activeProjectId);
  const viewMode = resolveVisibleView(routedViewMode, hiddenViews);

  // #323: cross-project deep links (inbox gate entries, sticky gate toasts,
  // desktop notifications) dispatch SELECT_PROJECT_EVENT from lib-layer code;
  // BoardPage owns handleProjectChange, so it performs the actual switch here.
  const projectChangeRef = useRef(handleProjectChange);
  projectChangeRef.current = handleProjectChange;
  const activeProjectIdSelectRef = useRef(activeProjectId);
  activeProjectIdSelectRef.current = activeProjectId;
  useEffect(() => {
    function onSelectProject(e: Event) {
      const detail = (e as CustomEvent<SelectProjectDetail>).detail;
      if (!detail?.projectId || detail.projectId === activeProjectIdSelectRef.current) return;
      // First step of a project -> view -> issue chain (#446): coalesce the
      // resulting URL writes so the user gets ONE back-step, not three.
      markProgrammaticNavigation();
      void projectChangeRef.current(detail.projectId);
    }
    window.addEventListener(SELECT_PROJECT_EVENT, onSelectProject);
    return () => window.removeEventListener(SELECT_PROJECT_EVENT, onSelectProject);
  }, []);

  // #413: open the issue a deep link names. `columnsRef` (not `columns`) so the listener is
  // registered once and still reads the CURRENT board — a link fired right after a project
  // switch would otherwise resolve against the previous project's columns.
  const applyIssueFocus = useCallback((detail: FocusIssueDetail): boolean => {
    const issue = columnsRef.current
      .flatMap((col) => col.issues)
      .find((i) => (detail.issueId ? i.id === detail.issueId : i.issueNumber === detail.issueNumber));
    if (!issue) return false;
    // A link that names a WORKSPACE (an inbox "finished, waiting to land" item)
    // is about that workspace, so open the drawer, not the detail panel — the
    // URL then says `/issue/<n>/workspace` and reloads as the drawer.
    if (detail.panel === "workspace" || detail.workspaceId) {
      openWorkspacePanelRef.current(issue, detail.workspaceId);
    } else {
      setWorkspaceIssue(null);
      setSelectedIssue(issue);
    }
    return true;
  }, [columnsRef, setSelectedIssue, setWorkspaceIssue]);

  // A cross-project link (inbox item) fires its focus while the project switch
  // is still in flight, so the issue is not on the CURRENT board yet. Hold it
  // until that project's columns arrive — bounded, so a link naming an issue
  // that never shows up cannot pop a panel open minutes later.
  const pendingFocusRef = useRef<{ detail: FocusIssueDetail; expiresAt: number } | null>(null);
  useEffect(() => {
    function onFocusIssue(e: Event) {
      const detail = (e as CustomEvent<FocusIssueDetail>).detail;
      if (!detail) return;
      // Usually the last step of a project -> view -> issue chain (#446).
      markProgrammaticNavigation();
      pendingFocusRef.current = applyIssueFocus(detail)
        ? null
        : { detail, expiresAt: Date.now() + FOCUS_ISSUE_HOLD_MS };
    }
    window.addEventListener(FOCUS_ISSUE_EVENT, onFocusIssue);
    return () => window.removeEventListener(FOCUS_ISSUE_EVENT, onFocusIssue);
  }, [applyIssueFocus]);

  useEffect(() => {
    const held = pendingFocusRef.current;
    if (!held) return;
    if (Date.now() > held.expiresAt) {
      pendingFocusRef.current = null;
      return;
    }
    // Still the SAME click: its history entry already exists, so the URL write
    // this focus triggers must replace rather than add a second back-step.
    navigationBurst.markSilent(Date.now());
    if (applyIssueFocus(held.detail)) pendingFocusRef.current = null;
  }, [columns, applyIssueFocus]);


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
    columnsRef,
    refetchBoard,
    setButlerInitialPrompt,
    handleViewModeChange,
  });
  // Close the loop for the route hook and the FOCUS_ISSUE listener above, both
  // of which are declared before this hook exists.
  openWorkspacePanelRef.current = (issue, workspaceId) => handleManageWorkspaces(issue, workspaceId);

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
      useBoardFilterStore.getState().setStatusFilterId(null);
    }
  }, [columns, statusFilterId]);

  useEffect(() => {
    if (activeTagIds.size > 0 && tagsLoaded) {
      const validIds = new Set([...activeTagIds].filter((id) => allTags.some((t) => t.id === id)));
      if (validIds.size !== activeTagIds.size) {
        useBoardFilterStore.getState().pruneTagFilter(validIds);
      }
    }
  }, [allTags, activeTagIds, tagsLoaded]);

  const handleMilestoneOverviewClick = useCallback((milestoneId: string) => {
    boardFilterActions.setMilestoneFilterId(milestoneId);
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
    selectedIssue, ticketTrail, openIssueById,
    handleViewModeChange, refetchBoard, setCollapsedGroups,
  });

  // Multi-repo gate (#82): the Multi-Repo Monitor is only offered when the active
  // project has >0 additional repos registered.
  const [hasAdditionalRepos, setHasAdditionalRepos] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setHasAdditionalRepos(false);
    if (!activeProjectId) return;
    fetchProjectRepos(queryClient, activeProjectId)
      .then((rows) => { if (!cancelled) setHasAdditionalRepos(rows.length > 0); })
      .catch(() => { /* single-repo behavior on failure */ });
    return () => { cancelled = true; };
  }, [activeProjectId, queryClient]);

  // Keyboard shortcuts (cursor/search/focus state is read from the board
  // stores inside the hook — no setter wiring from this container).
  useBoardKeyboardShortcuts(
    {
      columnsRef,
      columns,
      filteredColumns,
      activeColumns,
      archiveColumns,
      archiveExpanded,
      viewMode,
      projects,
      activeProjectId,
      hasAdditionalRepos,
    },
    {
      handleIssueClick,
      handleViewModeChange,
      handleProjectChange,
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
        {showGlobalButler ? (
          <div className="h-[calc(100vh-3rem)]">
            <ButlerView
              projectId={GLOBAL_BUTLER_PROJECT_ID}
              columns={[]}
              liveActivity={{}}
              liveStats={{}}
              onIssueClick={() => {}}
              onExit={() => setShowGlobalButler(false)}
            />
          </div>
        ) : (
          <div className="flex items-center justify-center h-96 text-gray-500 dark:text-gray-400">
            <div className="text-center">
              <p className="text-lg font-medium text-gray-700 dark:text-gray-300 mb-2">
                No projects registered
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Click the <strong>+</strong> button in the header to register a git repo as a project.
              </p>
              <button
                onClick={() => setShowGlobalButler(true)}
                className="mt-4 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-md hover:bg-brand-700"
              >
                Or ask the Butler to set one up
              </button>
            </div>
          </div>
        )}
      </Layout>
    );
  }

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const { handleCreateIssue, handleUpdateIssue, handleDeleteIssue, handleDropOnAgentSlot } = createBoardIssueActions({
    activeProject: activeProject ?? null, activeAgentsTarget, columns, columnsRef, pendingBoardRefreshRef,
    refetchBoard, setColumns, setCreatingInColumnId, setError, setExpandedCreatePanel,
    setMutating,
  });
  const canStartWorkspace = !!activeProject?.repoPath;

  function handleNotificationEventClick(event: NotificationEvent) {
    // Gate entries deep-link to the loop pane (#301) — they carry no issue.
    if (event.type === "plugin_gate" && event.pluginSlug && event.loopName) {
      usePluginViewStore.getState().focusLoop(event.pluginSlug, event.loopName);
      handleViewModeChange("plugin-views");
      return;
    }
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
        bulk,
        canStartWorkspace,
        collapsedGroups,
        columnWidths,
        columns,
        columnsRef,
        creatingInColumnId,
        expandedCreatePanel,
        milestones,
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
        handleMilestoneOverviewClick,
        loadSavedViewTags,
        loadTags,
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
