import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layout } from "../components/Layout.js";
import { useTheme } from "../hooks/useTheme.js";
import { useAgentQuestionsCount } from "../components/AgentQuestionsPanel.js";
import { BoardErrorBoundary } from "../components/BoardErrorBoundary.js";
import { BacklogView } from "../components/BacklogView.js";
import { MilestoneFilterBanner } from "../components/MilestoneFilterBanner.js";
import { BoardSecondaryViews } from "../components/BoardSecondaryViews.js";
import { useBoardLiveHandlers } from "../hooks/useBoardLiveHandlers.js";
import { useBoardPanelNavigation } from "../hooks/useBoardPanelNavigation.js";
import { useProjectManagement } from "../hooks/useProjectManagement.js";
import { useBoardFilters } from "../hooks/useBoardFilters.js";
import { useBoardIssueActions } from "../hooks/useBoardIssueActions.js";
import { stringifyForIssueCard, deferUntilIdle } from "../lib/boardCardSnapshot.js";
import { BoardKanbanView } from "../components/BoardKanbanView.js";
import { RecentlyMergedStrip } from "../components/RecentlyMergedStrip.js";
import { BoardStats } from "../components/BoardStats.js";
import { BoardToolbar } from "../components/BoardToolbar.js";
import { BoardFilterMenu } from "../components/BoardFilterMenu.js";
import { SavedBoardViews } from "../components/SavedBoardViews.js";
import { ExportImportMenu } from "../components/ExportImportMenu.js";
import type { CreateIssueFormState } from "../components/CreateIssueForm.js";
// Lazy: opened on user action (issue click / workspace open), and they pull in
// react-markdown — no need to ship them on the initial board paint.
const IssueDetailPanel = lazy(() => import("../components/IssueDetailPanel.js").then((m) => ({ default: m.IssueDetailPanel })));
const WorkspacePanel = lazy(() => import("../components/WorkspacePanel.js").then((m) => ({ default: m.WorkspacePanel })));
import { SkeletonBoard } from "../components/SkeletonBoard.js";
import { ToastContainer, showToast } from "../components/Toast.js";
import { MentionProvider } from "../lib/MentionContext.js";
import { apiFetch, apiPost } from "../lib/api.js";
import { setBoardDragData, getBoardDragData } from "../lib/dragData.js";
import { matchesBoardFilters } from "../lib/boardFiltering.js";
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
import { BoardBulkActionBar } from "../components/BoardBulkActionBar.js";
// Lazy: aggregates ~20 user-action panels (Settings, Codemod, MergeQueue,
// TranscriptSearch, CommandPalette, …). Rendered unconditionally though, and it hosts
// the event-driven ApprovalDialog, so the chunk is prefetched on idle after first
// paint (see effect below) to avoid a cold-fetch delay when an agent approval arrives.
const BoardOverlayPanels = lazy(() => import("../components/BoardOverlayPanels.js").then((m) => ({ default: m.BoardOverlayPanels })));
import { AgentLiveTickerPanel } from "../components/AgentLiveTickerPanel.js";
import { useAgentLiveTicker } from "../hooks/useAgentLiveTicker.js";
import type {
  DependencyInfo,
  IssueWithStatus,
  MilestoneResponse,
  StatusWithIssues,
  UpdateIssueRequest,
} from "@agentic-kanban/shared";
import type { BoardViewState, SavedViewReference } from "../lib/boardSavedViews.js";

/** Lightweight fallback shown for the ~1 frame it takes to fetch a lazy view chunk. */
function ViewLoadingFallback() {
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center text-gray-400 dark:text-gray-500">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent" aria-label="Loading view" />
    </div>
  );
}

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

/** Trailing-debounce window for coalescing WS-triggered board refetches. */
const REFETCH_DEBOUNCE_MS = 250;

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
  const boardEtagRef = useRef<Record<string, string>>({});
  // Coalesced-refetch bookkeeping: monotonic sequence guard (discard responses
  // that resolve after a newer one was applied), trailing-debounce timer, and
  // in-flight dedupe with a dirty flag for one follow-up fetch.
  const refetchSeqRef = useRef(0);
  const lastAppliedSeqRef = useRef(0);
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetchInFlightRef = useRef(false);
  const refetchDirtyRef = useRef(false);
  const runCoalescedRefetchRef = useRef<() => void>(() => {});
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

  const refetchBoard = useCallback(async (projectId?: string, options?: { force?: boolean }) => {
    const pid = projectId || activeProjectId;
    if (!pid) return;
    // Monotonic sequence guard: overlapping refetches can resolve out of
    // order; only the response of the newest request may be applied. The
    // 304 path is covered too — it applies nothing and leaves the newer
    // state (and its ETag) untouched.
    const seq = ++refetchSeqRef.current;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // On a forced refetch (e.g. project switch, where columns were just
    // cleared) we must NOT send If-None-Match: a 304 would early-return the
    // now-empty columnsRef and leave the board blank. Skip the conditional so
    // the server always sends the full board back.
    const cachedEtag = options?.force ? undefined : boardEtagRef.current[pid];
    if (cachedEtag) headers["If-None-Match"] = cachedEtag;
    const res = await fetch(`/api/projects/${pid}/board`, { headers });
    if (res.status === 304) {
      return columnsRef.current;
    }
    if (!res.ok) {
      let message = `API error: ${res.status} ${res.statusText}`;
      try {
        const body: unknown = await res.json();
        if ((body as any).error) message = (body as any).error;
      } catch {}
      throw new Error(message);
    }
    const board = await res.json() as StatusWithIssues[];
    if (seq <= lastAppliedSeqRef.current) {
      // A newer refetch already applied its response — discard this stale
      // one so it can't clobber fresher columns or the fresher ETag.
      return columnsRef.current;
    }
    lastAppliedSeqRef.current = seq;
    const etag = res.headers.get("ETag");
    if (etag) boardEtagRef.current[pid] = etag;
    // Reconcile object identity: reuse unchanged issue refs so IssueCard.memo skips re-render
    const prevCols = columnsRef.current;
    if (prevCols.length > 0) {
      const prevByIssueId = new Map(prevCols.flatMap(c => c.issues).map(i => [i.id, i]));
      const prevIssueSignatures = new Map<string, string>(Array.from(prevByIssueId, ([issueId, issue]) => [issueId, stringifyForIssueCard(issue)]));
      for (const col of board) {
        col.issues = col.issues.map(issue => {
          const prev = prevByIssueId.get(issue.id);
          if (!prev) return issue;
          const prevSignature = prevIssueSignatures.get(issue.id);
          if (prevSignature !== undefined && prevSignature === stringifyForIssueCard(issue)) return prev;
          return issue;
        });
      }
    }
    setColumns(board);
    columnsRef.current = board;
    const inactiveIssueIds = new Set<string>();
    for (const col of board) {
      for (const issue of col.issues) {
        const ws = issue.workspaceSummary?.main;
        if (!ws || (ws.status !== "active" && ws.status !== "fixing")) {
          inactiveIssueIds.add(issue.id);
        }
      }
    }
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

  // Coalesced board refetch: agent merge/exit cascades broadcast 3-6
  // board_changed events within 1-2s, and each used to trigger its own full
  // /board fetch. runCoalescedRefetch dedupes against an in-flight fetch
  // (dirty flag -> exactly one follow-up on completion); scheduleRefetch
  // collapses an event burst into one trailing fetch per 250ms window.
  const runCoalescedRefetch = useCallback(() => {
    if (refetchInFlightRef.current) {
      refetchDirtyRef.current = true;
      return;
    }
    refetchInFlightRef.current = true;
    void refetchBoard()
      .catch(() => {
        // WS-triggered refreshes were previously fire-and-forget; keep
        // failures non-fatal (the next board event retries).
      })
      .finally(() => {
        refetchInFlightRef.current = false;
        if (refetchDirtyRef.current) {
          refetchDirtyRef.current = false;
          runCoalescedRefetchRef.current();
        }
      });
  }, [refetchBoard]);
  runCoalescedRefetchRef.current = runCoalescedRefetch;

  const scheduleRefetch = useCallback(() => {
    if (refetchTimerRef.current !== null) clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null;
      runCoalescedRefetchRef.current();
    }, REFETCH_DEBOUNCE_MS);
  }, []);

  // Drop any pending coalesced refetch on unmount.
  useEffect(() => () => {
    if (refetchTimerRef.current !== null) clearTimeout(refetchTimerRef.current);
  }, []);

  // Keep selectedIssue in sync with board data (F6 stale data fix)
  useEffect(() => {
    if (!selectedIssue) return;
    for (const col of columns) {
      const found = col.issues.find((i) => i.id === selectedIssue.id);
      if (found) {
        // The board payload strips `description` (the panel lazy-loads it). A
        // background board refresh must NOT count the stripped (undefined)
        // description as a change, nor clobber the loaded one — otherwise the
        // open panel's body vanishes on the next board_changed/poll tick.
        const boardDescDiffers = found.description !== undefined && found.description !== selectedIssue.description;
        if (found.title !== selectedIssue.title ||
            boardDescDiffers ||
            found.issueType !== selectedIssue.issueType ||
            found.statusId !== selectedIssue.statusId ||
            found.statusName !== selectedIssue.statusName ||
            found.updatedAt !== selectedIssue.updatedAt ||
            found.workspaceSummary?.main?.contextTokens !== selectedIssue.workspaceSummary?.main?.contextTokens ||
            found.workspaceSummary?.main?.lastTool !== selectedIssue.workspaceSummary?.main?.lastTool ||
            found.workspaceSummary?.main?.status !== selectedIssue.workspaceSummary?.main?.status) {
          setSelectedIssue(
            found.description === undefined && selectedIssue.description !== undefined
              ? { ...found, description: selectedIssue.description }
              : found,
          );
        }
        return;
      }
    }
    setSelectedIssue(null);
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

  async function handleDuplicateIssue(issue: IssueWithStatus) {
    try {
      const result = await apiPost<{ id: string; issueNumber: number; title: string }>(`/api/issues/${issue.id}/duplicate`);
      await refetchBoard();
      showToast(`Duplicated as #${result.issueNumber}`, "success");
      openIssueById(result.id);
    } catch {
      showToast("Failed to duplicate issue", "error");
    }
  }

  const handleMentionClick = useCallback(
    (issueId: string) => {
      openIssueById(issueId);
    },
    [openIssueById],
  );

  useEffect(() => {
    if (!selectedIssue) return;
    ticketTrail.visit({
      id: selectedIssue.id,
      number: selectedIssue.issueNumber ?? null,
      title: selectedIssue.title,
    });
  }, [selectedIssue?.id, selectedIssue?.issueNumber, selectedIssue?.title, ticketTrail.visit]);

  useEffect(() => {
    if (!keyboardCursorIssueId) return;
    const el = document.querySelector(`[aria-current="true"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [keyboardCursorIssueId]);

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

  const handleCreatedDateDrilldown = useCallback((dateKey: string) => {
    setCreatedDateFilter(dateKey);
    handleViewModeChange("table");
  }, [handleViewModeChange]);

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
    <MentionProvider value={{ issues: allMentionIssues, onMentionClick: handleMentionClick }}>
    <Layout
      projects={projects}
      activeProjectId={activeProjectId}
      onProjectChange={handleProjectChange}
      onUnregisterProject={handleUnregisterProject}
      onArchiveProject={handleArchiveProject}
      onUnarchiveProject={handleUnarchiveProject}
      archivedProjects={archivedProjects}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      onRegisterProject={handleRegisterProject}
      onCreateProject={handleCreateProject}
      onSettingsClick={() => panels.setShowSettings(true)}
      onAllWorkspacesClick={() => panels.setShowAllWorkspaces(true)}
      onLaunchFailuresClick={() => panels.setShowLaunchFailures(true)}
      onWorktreeOverviewClick={() => panels.setShowWorktreeOverview(true)}
      onProjectHealthClick={() => panels.setShowProjectHealth(true)}
      isDark={isDark}
      onThemeToggle={() => setTheme(isDark ? "light" : "dark")}
      notificationEvents={notifications.events}
      notificationUnreadCount={notifications.unreadCount}
      notificationOpen={notifications.isOpen}
      onNotificationOpen={notifications.openDropdown}
      onNotificationClose={notifications.closeDropdown}
      onNotificationMarkRead={notifications.markRead}
      onNotificationEventClick={handleNotificationEventClick}
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
            <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm font-medium">Saving...</span>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2 p-2 sm:p-4 h-full overflow-hidden">
        <div className="flex flex-wrap items-center gap-2">
        {viewMode !== "butler" && (
          <BoardStats
            activeColumns={activeColumns}
            archiveColumns={archiveColumns}
            searchQuery={searchQuery}
            projectId={activeProjectId}
          />
        )}
        <BoardToolbar
          activeColumns={activeColumns}
          focusMode={focusMode}
          onFocusModeChange={(v) => {
            setFocusMode(v);
            try { sessionStorage.setItem("board-focus-mode", v ? "1" : "0"); } catch { /* ignore */ }
          }}
          onShowQuickTasks={() => panels.setShowQuickTasks(true)}
          autoMonitor={prefs.autoMonitor}
          monitorRunning={prefs.monitorRunning}
          onMonitorRunNow={prefs.handleMonitorRunNow}
          monitorStatus={prefs.monitorStatus}
          onToggleAutoMonitor={prefs.toggleAutoMonitor}
          autoMonitorInterval={prefs.autoMonitorInterval}
          onIntervalChange={prefs.handleIntervalChange}
          nudgeAutoStart={prefs.nudgeAutoStart}
          onNudgeAutoStartChange={prefs.handleNudgeAutoStartChange}
          nudgeWipLimit={prefs.nudgeWipLimit}
          onNudgeWipLimitChange={prefs.handleNudgeWipLimitChange}
          columns={columns}
          onOpenWorkspace={handleOpenWorkspaceById}
          viewMode={viewMode}
          onViewModeChange={handleViewModeChange}
          butlerBadgeCount={agentQuestionsCount}
          projectId={activeProjectId}
          onVoiceIssueCreated={() => refetchBoard()}
          onShowTimeReport={activeProjectId ? () => panels.setShowTimeReport(true) : undefined}
          onShowMergeQueue={() => panels.setShowMergeQueue(true)}
          mergeQueueCount={columns.flatMap(c => c.issues).filter(i => {
            const ws = i.workspaceSummary?.main;
            return i.statusName === "In Review" && ws && ws.status !== "closed";
          }).length}
          onShowRunQueueForecast={() => panels.setShowRunQueueForecast(true)}
          runQueueOpenSlots={runQueueForecast.openSlots}
          onShowLiveActivityTicker={() => panels.setShowLiveActivityTicker((prev) => !prev)}
          liveActivityCount={tickerEntries.length}
          onViewAllHealthEvents={() => handleViewModeChange("health-events")}
          cardDensity={prefs.cardDensity}
          onCardDensityChange={prefs.handleCardDensityChange}
          visibilityColumns={visibilityColumns}
          hiddenColumns={prefs.hiddenColumns}
          onHiddenColumnsChange={prefs.handleHiddenColumnsChange}
          showPriorityLegend={prefs.showPriorityLegend}
          onShowPriorityLegendChange={prefs.handleShowPriorityLegendChange}
          showCardAgingHeatmap={prefs.showCardAgingHeatmap}
          onShowCardAgingHeatmapChange={prefs.handleShowCardAgingHeatmapChange}
          agingWarmDays={prefs.agingWarmDays}
          agingHotDays={prefs.agingHotDays}
          onAgingThresholdsChange={prefs.handleAgingThresholdsChange}
          swimlaneDimension={swimlaneDimension}
          onSwimlaneChange={handleSwimlaneChange}
        />
        </div>
        {viewMode === "kanban" && (
          <BoardBulkActionBar
            selectedIssues={bulk.selectedBoardIssues}
            hasArchivedSelection={bulk.hasArchivedBoardSelection}
            boardBulkUpdating={bulk.boardBulkUpdating}
            columns={columns}
            allTags={allTags}
            onBulkUpdate={bulk.handleBoardBulkUpdate}
            onBulkAddTag={bulk.handleBoardBulkAddTag}
            onLoadTags={loadTags}
            onClearSelection={bulk.clearSelection}
          />
        )}
        {switchingProject ? <SkeletonBoard /> : <>
        {/* All non-kanban views are lazy-loaded; one Suspense boundary covers the whole
            switch since exactly one view renders at a time. The kanban board itself is
            eager and lives outside this boundary, so it never shows the fallback. */}
        <Suspense fallback={<ViewLoadingFallback />}>
        <BoardSecondaryViews
          viewMode={viewMode}
          activeProjectId={activeProjectId}
          columns={columns}
          searchQuery={searchQuery}
          liveActivity={sessionActivity}
          liveStats={liveStats}
          sessionTodos={sessionTodos}
          graphFocusIssueId={graphFocusIssueId}
          createdDateFilter={createdDateFilter}
          activeAgentsTarget={activeAgentsTarget}
          canStartWorkspace={canStartWorkspace}
          butlerInitialPrompt={butlerInitialPrompt}
          onIssueClick={handleIssueClick}
          onManageWorkspaces={handleManageWorkspaces}
          onViewModeChange={handleViewModeChange}
          onMilestoneClick={handleMilestoneOverviewClick}
          onOpenWorkspaceById={handleOpenWorkspaceById}
          onCreatedDateClick={handleCreatedDateDrilldown}
          onClearCreatedDateFilter={() => setCreatedDateFilter(null)}
          onDropIssue={handleDropOnAgentSlot}
          onRefresh={() => refetchBoard()}
          onButlerPromptConsumed={() => setButlerInitialPrompt(null)}
          setSelectedIssue={setSelectedIssue}
          setWorkspaceIssue={setWorkspaceIssue}
          setWorkspaceOpenCreate={setWorkspaceOpenCreate}
          setWorkspaceInitial={setWorkspaceInitial}
        />
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
              pendingIssueIds={pendingIssueIds}
              pendingWorkspaceIssueIds={pendingWorkspaceIssueIds}
              canStartWorkspace={canStartWorkspace}
              onIssueClick={handleIssueClick}
              onWorkspaceClick={handleManageWorkspaces}
              onOpenDiff={handleOpenDiff}
              onStartWorkspace={handleStartWorkspace}
              onDryRun={panels.setDryRunIssue}
              onDragStart={handleBoardDragStart}
              onDrop={handleDrop}
              onPromoteToTodo={handlePromoteBacklogIssue}
              onCreateIssue={handleCreateIssue}
              onExpandCreate={(statusId, statusName, state) => setExpandedCreatePanel({ statusId, statusName, state })}
            />
          </BoardErrorBoundary>
        )}
        </Suspense>
        {viewMode === "kanban" && milestoneFilterId && (
          <MilestoneFilterBanner
            milestoneId={milestoneFilterId}
            milestones={milestones}
            columns={columns}
            onClear={() => setMilestoneFilterId(null)}
          />
        )}
        {viewMode === "kanban" && (
          <RecentlyMergedStrip
            columns={columns}
            collapsed={prefs.recentMergesCollapsed}
            onToggleCollapsed={() => prefs.handleRecentMergesCollapsedChange(!prefs.recentMergesCollapsed)}
            onOpenDiff={handleOpenDiff}
          />
        )}
        {viewMode === "kanban" && (
          <BoardKanbanView
            activeColumns={activeColumns}
            archiveColumns={archiveColumns}
            allColumns={columns}
            focusMode={focusMode}
            projectId={activeProjectId}
            columnWidths={columnWidths}
            dynamicColumnScaling={prefs.dynamicColumnScaling}
            cardDensity={prefs.cardDensity}
            creatingInColumnId={creatingInColumnId}
            searchQuery={searchQuery}
            sessionActivity={sessionActivity}
            liveStats={liveStats}
            sessionTodos={sessionTodos}
            pendingIssueIds={pendingIssueIds}
            pendingWorkspaceIssueIds={pendingWorkspaceIssueIds}
            collapsedArchive={collapsedGroups.has("archive")}
            canStartWorkspace={canStartWorkspace}
            onToggleArchive={() => toggleGroup("archive")}
            onCreateClick={setCreatingInColumnId}
            onCreateCancel={() => setCreatingInColumnId(null)}
            onIssueClick={handleBoardIssueClick}
            onWorkspaceClick={handleManageWorkspaces}
            onOpenDiff={handleOpenDiff}
            onStartWorkspace={handleStartWorkspace}
            onDryRun={panels.setDryRunIssue}
            onDragStart={handleBoardDragStart}
            onDrop={handleDrop}
            swimlaneDimension={swimlaneDimension}
            onDropWithLane={handleDropWithLane}
            onDuplicate={handleDuplicateIssue}
            onMoveToNext={handleMoveToNext}
            onDeleteIssue={handleDeleteIssue}
            onColumnResizeStart={handleColumnResizeStart}
            onColumnResizeReset={resetColumnWidth}
            onCreateIssue={handleCreateIssue}
            onExpandCreate={(statusId, statusName, state) => setExpandedCreatePanel({ statusId, statusName, state })}
            selectedIssueIds={bulk.selectedBoardIssueIds}
            keyboardCursorIssueId={keyboardCursorIssueId}
            allProjectTags={allTags}
            quickUpdate={{
              onPriorityChange: handleQuickPriorityChange,
              onAddTag: handleQuickAddTag,
              onRemoveTag: handleQuickRemoveTag,
              onTogglePinned: handleQuickTogglePinned,
            }}
            wipLimits={prefs.wipLimits}
            onSetWipLimit={prefs.handleSetWipLimit}
            onColumnReorder={handleColumnReorder}
            showAgingHeatmap={prefs.showCardAgingHeatmap}
            agingWarmDays={prefs.agingWarmDays}
            agingHotDays={prefs.agingHotDays}
          />
        )}
        </>}
      </div>
      {selectedIssue && (
        // Error boundary so a render throw inside the panel can't unmount the
        // whole app (blank-screen "frontend crash"). It contains the error to
        // the panel and surfaces the message instead, the same way every board
        // view is guarded. `key` resets the boundary when switching issues so a
        // crash on one ticket doesn't stick when opening another.
        <BoardErrorBoundary key={selectedIssue.id} columnName="Issue Details">
        <Suspense fallback={null}>
        <IssueDetailPanel
          issue={selectedIssue}
          statuses={columns.map((col) => ({ id: col.id, name: col.name }))}
          onUpdate={handleUpdateIssue}
          onDelete={handleDeleteIssue}
          onClose={() => setSelectedIssue(null)}
          onManageWorkspaces={handleManageWorkspaces}
          onStartWorkspace={handleStartWorkspace}
          onIssueUpdate={setSelectedIssue}
          onChatAboutTicket={handleChatAboutTicket}
          onNavigateToIssue={(issueId) => openIssueById(issueId)}
          onViewInGraph={(issueId) => {
            setGraphFocusIssueId(issueId);
            handleViewModeChange("graph");
            setSelectedIssue(null);
          }}
          trail={trailControls}
        />
        </Suspense>
        </BoardErrorBoundary>
      )}
      {workspaceIssue && (
        <BoardErrorBoundary key={workspaceIssue.id} columnName="Workspace">
          <Suspense fallback={null}>
            <WorkspacePanel
              key={`${workspaceIssue.id}:${workspaceInitial?.workspaceId ?? "new"}:${workspaceOpenCreate ? "create" : "view"}`}
              issue={workspaceIssue}
              project={activeProject ?? null}
              onClose={() => { setWorkspaceIssue(null); setWorkspaceInitial(null); setWorkspaceOpenCreate(false); setWorkspaceInitialDiff(false); }}
              onWorkspaceChange={() => refetchBoard()}
              onWorkspaceCreating={(issueId) => setPendingWorkspaceIssueIds((prev) => new Set([...prev, issueId]))}
              onWorkspaceCreateSettled={(issueId) => setPendingWorkspaceIssueIds((prev) => {
                const next = new Set(prev);
                next.delete(issueId);
                return next;
              })}
              initialWorkspaceId={workspaceInitial?.workspaceId}
              initialSessionId={workspaceInitial?.sessionId}
              initialShowCreate={workspaceOpenCreate}
              initialShowDiff={workspaceInitialDiff}
              liveStats={liveStats[workspaceIssue.id] ?? null}
            />
          </Suspense>
        </BoardErrorBoundary>
      )}
      <ToastContainer />
      {panels.showLiveActivityTicker && (
        <AgentLiveTickerPanel
          entries={tickerEntries}
          columns={columns}
          onClose={() => panels.setShowLiveActivityTicker(false)}
          onWorkspaceClick={(issue, workspaceId) => {
            setWorkspaceIssue(issue);
            setWorkspaceInitial({ workspaceId, sessionId: "" });
            setWorkspaceOpenCreate(false);
            panels.setShowLiveActivityTicker(false);
          }}
        />
      )}
      <Suspense fallback={null}>
      <BoardOverlayPanels
        {...panels.overlayPanelProps}
        onWorkspaceStarted={(workspaceId, issue) => {
          panels.closeStartWorkspacePicker();
          setWorkspaceIssue(issue);
          setWorkspaceInitial({ workspaceId, sessionId: "" });
          setWorkspaceOpenCreate(false);
          refetchBoard();
        }}
        activeProjectId={activeProjectId}
        columns={columns}
        nudgeWipLimit={prefs.nudgeWipLimit}
        viewMode={viewMode}
        columnsRef={columnsRef}
        workspaceIssue={workspaceIssue}
        workspaceInitial={workspaceInitial}
        workspaceOpenCreate={workspaceOpenCreate}
        selectedIssue={selectedIssue}
        handleStartWorkspace={handleStartWorkspace}
        approvalRequests={approvalRequests}
        setApprovalRequests={setApprovalRequests}
        moveToDonePending={moveToDonePending}
        setMoveToDonePending={setMoveToDonePending}
        dependencyImpactPending={dependencyImpactPending}
        setDependencyImpactPending={setDependencyImpactPending}
        expandedCreatePanel={expandedCreatePanel}
        setExpandedCreatePanel={setExpandedCreatePanel}
        backlogColumn={backlogColumn}
        activeColumns={activeColumns}
        handleCreateIssue={handleCreateIssue}
        canStartWorkspace={canStartWorkspace}
        refetchBoard={refetchBoard}
        handleProjectChange={handleProjectChange}
        onSettingsReloaded={(s, monitorStatus) => {
          prefs.setAutoReview(s.auto_review !== "false");
          prefs.setAutoMerge(s.auto_merge !== "false");
          if (monitorStatus) {
            // monitorStatus is set by the hook's internal interval but we can trigger a re-read
          }
        }}
        setWorkspaceIssue={setWorkspaceIssue}
        setWorkspaceInitial={setWorkspaceInitial}
        setWorkspaceOpenCreate={setWorkspaceOpenCreate}
        setSelectedIssue={setSelectedIssue}
        settingsBoardTools={
          <>
            {activeProjectId && (
              <SavedBoardViews
                projectId={activeProjectId}
                currentState={boardViewState}
                tags={boardTagOptions}
                onApply={applyBoardViewState}
                onLoadTags={loadSavedViewTags}
              />
            )}
            <BoardFilterMenu
              statuses={boardStatusOptions}
              statusFilterId={statusFilterId}
              onStatusFilterChange={setStatusFilterId}
              issueTypeFilter={issueTypeFilter}
              onIssueTypeFilterChange={handleIssueTypeFilterChange}
              priorityFilter={priorityFilter}
              onPriorityFilterChange={handlePriorityFilterChange}
              milestones={milestones}
              milestoneFilterId={milestoneFilterId}
              onMilestoneFilterChange={setMilestoneFilterId}
              showBlocked={showBlocked}
              onToggleBlocked={() => setShowBlocked((v) => !v)}
              showStaleOnly={showStaleOnly}
              onToggleStaleOnly={() => setShowStaleOnly((v) => !v)}
              tags={allTags}
              activeTagIds={activeTagIds}
              onTagFilterToggle={handleTagFilterToggle}
              onClearTagFilter={handleClearTagFilter}
            />
            <ExportImportMenu projectId={activeProjectId} />
          </>
        }
      />
      </Suspense>
    </Layout>
    </MentionProvider>
  );
}
