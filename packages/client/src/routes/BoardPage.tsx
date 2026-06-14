import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layout } from "../components/Layout.js";
import { useTheme } from "../hooks/useTheme.js";
// Code-split: every non-kanban view below is rendered only behind a `viewMode` guard,
// so it is loaded on demand. This keeps the heaviest chunks off the initial kanban
// paint — most notably WorkflowsView (which pulls in @xyflow/react + @dagrejs/dagre)
// and the markdown/chart-heavy analytics views. The explicit `.then(m => ({ default:
// m.X }))` form preserves each component's prop types through React.lazy.
const GraphView = lazy(() => import("../components/GraphView.js").then((m) => ({ default: m.GraphView })));
const TableView = lazy(() => import("../components/TableView.js").then((m) => ({ default: m.TableView })));
const AgentGrid = lazy(() => import("../components/AgentGrid.js").then((m) => ({ default: m.AgentGrid })));
const TimelineView = lazy(() => import("../components/TimelineView.js").then((m) => ({ default: m.TimelineView })));
const MetricsView = lazy(() => import("../components/MetricsView.js").then((m) => ({ default: m.MetricsView })));
const QualityMetricsView = lazy(() => import("../components/QualityMetricsView.js").then((m) => ({ default: m.QualityMetricsView })));
const ButlerView = lazy(() => import("../components/ButlerView.js").then((m) => ({ default: m.ButlerView })));
const WorkflowsView = lazy(() => import("../components/WorkflowsView.js").then((m) => ({ default: m.WorkflowsView })));
const WorkflowAnalyticsDashboard = lazy(() => import("../components/WorkflowAnalyticsDashboard.js").then((m) => ({ default: m.WorkflowAnalyticsDashboard })));
const InsightsPanel = lazy(() => import("../components/InsightsPanel.js").then((m) => ({ default: m.InsightsPanel })));
const DigestView = lazy(() => import("../components/DigestView.js").then((m) => ({ default: m.DigestView })));
const ActivityFeedView = lazy(() => import("../components/ActivityFeedView.js").then((m) => ({ default: m.ActivityFeedView })));
const FocusView = lazy(() => import("../components/FocusView.js").then((m) => ({ default: m.FocusView })));
const StrategyTargetsView = lazy(() => import("../components/StrategyTargetsView.js").then((m) => ({ default: m.StrategyTargetsView })));
const SwimlaneView = lazy(() => import("../components/SwimlaneView.js").then((m) => ({ default: m.SwimlaneView })));
const FlakyTestsPanel = lazy(() => import("../components/FlakyTestsPanel.js").then((m) => ({ default: m.FlakyTestsPanel })));
const MonitorCycleHistoryPanel = lazy(() => import("../components/MonitorCycleHistoryPanel.js").then((m) => ({ default: m.MonitorCycleHistoryPanel })));
const BoardHealthNotificationCenter = lazy(() => import("../components/BoardHealthNotificationCenter.js").then((m) => ({ default: m.BoardHealthNotificationCenter })));
const RunbooksView = lazy(() => import("../components/RunbooksView.js").then((m) => ({ default: m.RunbooksView })));
const SprintCapacityPlanner = lazy(() => import("../components/SprintCapacityPlanner.js").then((m) => ({ default: m.SprintCapacityPlanner })));
const ConstellationView = lazy(() => import("../components/ConstellationView.js").then((m) => ({ default: m.ConstellationView })));
const MomentumView = lazy(() => import("../components/MomentumView.js").then((m) => ({ default: m.MomentumView })));
const FireworksView = lazy(() => import("../components/FireworksView.js").then((m) => ({ default: m.FireworksView })));
const StaleWorkDashboard = lazy(() => import("../components/StaleWorkDashboard.js").then((m) => ({ default: m.StaleWorkDashboard })));
const ThroughputChart = lazy(() => import("../components/ThroughputChart.js").then((m) => ({ default: m.ThroughputChart })));
const ProviderMixChart = lazy(() => import("../components/ProviderMixChart.js").then((m) => ({ default: m.ProviderMixChart })));
const LeadTimeTrendChart = lazy(() => import("../components/LeadTimeTrendChart.js").then((m) => ({ default: m.LeadTimeTrendChart })));
const ScorecardDistributionChart = lazy(() => import("../components/ScorecardDistributionChart.js").then((m) => ({ default: m.ScorecardDistributionChart })));
const ProviderCostOverTimeChart = lazy(() => import("../components/ProviderCostOverTimeChart.js").then((m) => ({ default: m.ProviderCostOverTimeChart })));
const CalendarView = lazy(() => import("../components/CalendarView.js").then((m) => ({ default: m.CalendarView })));
const AgentThroughputLeaderboard = lazy(() => import("../components/AgentThroughputLeaderboard.js").then((m) => ({ default: m.AgentThroughputLeaderboard })));
const BurndownChart = lazy(() => import("../components/BurndownChart.js").then((m) => ({ default: m.BurndownChart })));
const DriveDashboard = lazy(() => import("../components/DriveDashboard.js").then((m) => ({ default: m.DriveDashboard })));
import { useAgentQuestionsCount } from "../components/AgentQuestionsPanel.js";
import { BoardErrorBoundary } from "../components/BoardErrorBoundary.js";
import { BacklogView } from "../components/BacklogView.js";
import { BoardKanbanView } from "../components/BoardKanbanView.js";
import { RecentlyMergedStrip } from "../components/RecentlyMergedStrip.js";
import { BoardStats } from "../components/BoardStats.js";
import { BoardToolbar } from "../components/BoardToolbar.js";
import { BoardFilterMenu } from "../components/BoardFilterMenu.js";
import { ExportImportMenu } from "../components/ExportImportMenu.js";
import type { CreateIssueFormState } from "../components/CreateIssueForm.js";
// Lazy: opened on user action (issue click / workspace open), and they pull in
// react-markdown — no need to ship them on the initial board paint.
const IssueDetailPanel = lazy(() => import("../components/IssueDetailPanel.js").then((m) => ({ default: m.IssueDetailPanel })));
const WorkspacePanel = lazy(() => import("../components/WorkspacePanel.js").then((m) => ({ default: m.WorkspacePanel })));
import { SkeletonBoard } from "../components/SkeletonBoard.js";
import { ToastContainer, showToast } from "../components/Toast.js";
import { suggestBranchName } from "../lib/branch.js";
import { MentionProvider } from "../lib/MentionContext.js";
import { apiFetch } from "../lib/api.js";
import { getSettings } from "../lib/settingsStore.js";
import { matchesBoardFilters } from "../lib/boardFiltering.js";
import { runCreateIssueFlow, type CreateIssuePayload } from "../lib/createIssueService.js";
import { applyLocalReorder, moveIssueToStatus } from "../lib/issueMoveHelpers.js";
import { createQuickUpdateHandlers } from "../lib/issueQuickUpdates.js";
import { useColumnResize } from "../lib/columnResizeHandler.js";
import { useBoardEvents, type LiveSessionStats, type TodoItem, type ApprovalRequest } from "../lib/useBoardEvents.js";
import { sendDesktopNotification } from "../lib/desktop.js";
import { useActivityNotifications, type NotificationEvent } from "../hooks/useActivityNotifications.js";
import { buildRunQueueForecast } from "../components/RunQueueForecastPanel.js";
import { useBoardPageRoute } from "./useBoardPageRoute.js";
import { useBoardPreferences } from "../hooks/useBoardPreferences.js";
import { useBoardPanels } from "../hooks/useBoardPanels.js";
import { useBoardNavigation } from "../hooks/useBoardNavigation.js";
import { useBoardBulkSelection } from "../hooks/useBoardBulkSelection.js";
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
function deferUntilIdle(cb: () => void): () => void {
  const w = window as unknown as {
    requestIdleCallback?: (cb: () => void) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (w.requestIdleCallback) {
    const handle = w.requestIdleCallback(cb);
    return () => w.cancelIdleCallback?.(handle);
  }
  const t = setTimeout(cb, 300);
  return () => clearTimeout(t);
}

function stringifyForIssueCard(issue: IssueWithStatus): string {
  const normalized = {
    id: issue.id,
    issueNumber: issue.issueNumber,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    issueType: issue.issueType,
    sortOrder: issue.sortOrder,
    statusId: issue.statusId,
    statusName: issue.statusName,
    projectId: issue.projectId,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    statusChangedAt: issue.statusChangedAt,
    workspaceSummary: issue.workspaceSummary,
    isBlocked: issue.isBlocked,
    isStale: issue.isStale,
    staleDays: issue.staleDays,
    columnAgeDays: issue.columnAgeDays,
    isColumnStale: issue.isColumnStale,
    skipAutoReview: issue.skipAutoReview,
    estimate: issue.estimate,
    dueDate: issue.dueDate,
    externalKey: issue.externalKey,
    externalUrl: issue.externalUrl,
    tags: issue.tags,
    checklist: issue.checklist,
    pinned: issue.pinned,
    milestoneId: issue.milestoneId,
    readyForMerge: (issue as IssueWithStatus & { readyForMerge?: boolean }).readyForMerge,
  };
  return JSON.stringify(normalized);
}

/** Milestone progress banner shown above the kanban board when a milestone filter is active. */
function MilestoneFilterBanner({
  milestoneId,
  milestones,
  columns,
  onClear,
}: {
  milestoneId: string;
  milestones: MilestoneResponse[];
  columns: StatusWithIssues[];
  onClear: () => void;
}) {
  const activeMilestone = milestones.find(m => m.id === milestoneId);
  if (!activeMilestone) return null;
  const allMilestoneIssues = columns.flatMap(c => c.issues).filter(i => i.milestoneId === milestoneId);
  const doneCount = allMilestoneIssues.filter(i => i.statusName === "Done").length;
  const total = allMilestoneIssues.length;
  return (
    <div className="mx-4 mb-2 flex items-center gap-3 px-3 py-2 rounded-md bg-violet-50 dark:bg-violet-950/40 border border-violet-200 dark:border-violet-800 text-sm">
      <svg className="w-4 h-4 text-violet-600 dark:text-violet-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 21V3l18 9-18 9z" />
      </svg>
      <span className="font-medium text-violet-800 dark:text-violet-200">{activeMilestone.name}</span>
      {activeMilestone.dueDate && (
        <span className="text-xs text-violet-600 dark:text-violet-400">
          due {new Date(activeMilestone.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
      )}
      <span className="ml-auto text-violet-700 dark:text-violet-300 font-medium">
        {doneCount}/{total} done
      </span>
      {total > 0 && (
        <div className="w-24 h-1.5 rounded-full bg-violet-200 dark:bg-violet-800 overflow-hidden">
          <div
            className="h-full bg-violet-600 dark:bg-violet-400 rounded-full transition-all"
            style={{ width: `${Math.round((doneCount / total) * 100)}%` }}
          />
        </div>
      )}
      <button
        onClick={onClear}
        title="Clear milestone filter"
        className="text-violet-500 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-200 ml-1"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

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
  const [searchQuery, setSearchQuery] = useState("");
  const [focusMode, setFocusMode] = useState(() => {
    try { return sessionStorage.getItem("board-focus-mode") === "1"; } catch { return false; }
  });
  const [statusFilterId, setStatusFilterId] = useState<string | null>(null);
  const [activeTagIds, setActiveTagIds] = useState<Set<string>>(new Set());
  const [milestoneFilterId, setMilestoneFilterId] = useState<string | null>(null);
  const [milestones, setMilestones] = useState<MilestoneResponse[]>([]);
  const [issueTypeFilter, setIssueTypeFilter] = useState<string | null>(null);
  const [swimlaneDimension, setSwimlaneDimension] = useState<"none" | "priority" | "tag">(() => {
    try { return (localStorage.getItem("kanban-swimlane") as "none" | "priority" | "tag") ?? "none"; } catch { return "none"; }
  });
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

  const refetchBoard = useCallback(async (projectId?: string) => {
    const pid = projectId || activeProjectId;
    if (!pid) return;
    // Monotonic sequence guard: overlapping refetches can resolve out of
    // order; only the response of the newest request may be applied. The
    // 304 path is covered too — it applies nothing and leaves the newer
    // state (and its ETag) untouched.
    const seq = ++refetchSeqRef.current;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const cachedEtag = boardEtagRef.current[pid];
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

  // Real-time board updates via WebSocket
  const handleBoardChange = useCallback((reason: string) => {
    if (reason.startsWith("project_")) {
      void (async () => {
        try {
          const nextProjectId = await loadProjectsRef.current();
          if (nextProjectId) {
            await refetchBoard(nextProjectId);
          } else {
            setColumns([]);
            columnsRef.current = [];
          }
        } catch {
          showToast("Failed to refresh projects", "error");
        }
      })();
      return;
    }

    if (reason === "session_completed") {
      sendDesktopNotification("Agentic Kanban", "Agent session completed");
    } else if (reason === "workspace_merged") {
      sendDesktopNotification("Agentic Kanban", "Workspace merged successfully");
    }

    // Activity notification bell — capture issue context from current board snapshot
    const relevantReasons = new Set([
      "workspace_merged", "workspace_ready_for_merge",
      "session_completed", "session_launched",
      "workflow_error", "workflow_transition",
    ]);
    if (relevantReasons.has(reason)) {
      // Find the most relevant issue from the current board snapshot.
      // Match the most recently-active workspace for any event tied to a workspace.
      // Workflow transitions move the issue (board not refreshed yet), so skip matching.
      let bestIssue: { id: string; issueNumber?: number; title?: string; workspaceId?: string } | undefined;
      if (reason !== "workflow_transition") {
        // Pick the issue with the most recently-active workspace
        let bestTime = 0;
        for (const col of columnsRef.current) {
          for (const iss of col.issues) {
            const ws = iss.workspaceSummary?.main;
            if (ws) {
              const wsTime = ws.lastSessionAt ? new Date(ws.lastSessionAt).getTime() : 0;
              if (wsTime > bestTime) {
                bestTime = wsTime;
                bestIssue = {
                  id: iss.id,
                  issueNumber: iss.issueNumber ?? undefined,
                  title: iss.title,
                  workspaceId: ws.id,
                };
              }
            }
          }
        }
      }
      addNotificationBoardEvent(reason, bestIssue);
    }

    if (creatingInColumnId) {
      pendingBoardRefreshRef.current = true;
      return;
    }
    scheduleRefetch();
  }, [refetchBoard, scheduleRefetch, creatingInColumnId, addNotificationBoardEvent]);

  const handleSessionActivity = useCallback((issueId: string, sessionId: string, activity: string) => {
    const isActive = columnsRef.current.some(col =>
      col.issues.some(iss => iss.id === issueId && (iss.workspaceSummary?.main?.status === "active" || iss.workspaceSummary?.main?.status === "fixing"))
    );
    if (!isActive) {
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
  }, []);

  const handleSessionStats = useCallback((issueId: string, stats: LiveSessionStats) => {
    const isActive = columnsRef.current.some(col =>
      col.issues.some(iss => iss.id === issueId && (iss.workspaceSummary?.main?.status === "active" || iss.workspaceSummary?.main?.status === "fixing"))
    );
    if (!isActive) return;
    setLiveStats((prev) => {
      if (prev[issueId]?.model === stats.model && prev[issueId]?.contextTokens === stats.contextTokens && prev[issueId]?.toolUses === stats.toolUses && prev[issueId]?.subagentCount === stats.subagentCount) return prev;
      return { ...prev, [issueId]: stats };
    });
  }, []);

  const handleSessionTodos = useCallback((issueId: string, todos: TodoItem[]) => {
    setSessionTodos((prev) => ({ ...prev, [issueId]: todos }));
  }, []);

  const handleApprovalRequested = useCallback((req: ApprovalRequest) => {
    setApprovalRequests((prev) => [...prev, req]);
    // Find the issue corresponding to this workspace for the notification
    let approvalIssue: { id: string; issueNumber?: number; title?: string } | undefined;
    if (req.workspaceId) {
      for (const col of columnsRef.current) {
        const iss = col.issues.find((i) => i.workspaceSummary?.main?.id === req.workspaceId);
        if (iss) {
          approvalIssue = { id: iss.id, issueNumber: iss.issueNumber ?? undefined, title: iss.title };
          break;
        }
      }
    }
    addNotificationApprovalEvent(req.workspaceId ?? req.sessionId, approvalIssue);
  }, [addNotificationApprovalEvent]);

  useBoardEvents(activeProjectId, handleBoardChange, handleSessionActivity, handleSessionStats, handleSessionTodos, handleApprovalRequested);

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

  useEffect(() => {
    if (!activeProjectId) return;
    try {
      const stored = localStorage.getItem(`board-type-filter-${activeProjectId}`);
      setIssueTypeFilter(stored || null);
    } catch {
      // ignore
    }
  }, [activeProjectId]);

  const handleIssueTypeFilterChange = useCallback((type: string | null) => {
    setIssueTypeFilter(type);
    if (activeProjectId) {
      try {
        if (type) {
          localStorage.setItem(`board-type-filter-${activeProjectId}`, type);
        } else {
          localStorage.removeItem(`board-type-filter-${activeProjectId}`);
        }
      } catch {
        // ignore
      }
    }
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) return;
    try {
      const stored = localStorage.getItem(`board-tag-filter-${activeProjectId}`);
      setActiveTagIds(stored ? new Set(stored.split(",").filter(Boolean)) : new Set());
    } catch {
      // ignore
    }
  }, [activeProjectId]);

  const handleTagFilterToggle = useCallback((tagId: string) => {
    setActiveTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) {
        next.delete(tagId);
      } else {
        next.add(tagId);
      }
      if (activeProjectId) {
        try {
          if (next.size > 0) {
            localStorage.setItem(`board-tag-filter-${activeProjectId}`, [...next].join(","));
          } else {
            localStorage.removeItem(`board-tag-filter-${activeProjectId}`);
          }
        } catch {
          // ignore
        }
      }
      return next;
    });
  }, [activeProjectId]);

  const handleClearTagFilter = useCallback(() => {
    setActiveTagIds(new Set());
    if (activeProjectId) {
      try {
        localStorage.removeItem(`board-tag-filter-${activeProjectId}`);
      } catch {
        // ignore
      }
    }
  }, [activeProjectId]);

  async function handleProjectChange(id: string) {
    setActiveProjectId(id);
    setColumns([]);
    columnsRef.current = [];
    setSelectedIssue(null);
    setWorkspaceIssue(null);
    setSwitchingProject(true);
    try {
      await apiFetch("/api/preferences/active-project", {
        method: "PUT",
        body: JSON.stringify({ projectId: id }),
      });
      await refetchBoard(id);
    } catch {
      showToast("Failed to switch project", "error");
    } finally {
      setSwitchingProject(false);
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

  async function handleCreateProject(name: string, path: string, gitignoreTemplate: string, generateReadme: boolean) {
    const body: Record<string, unknown> = { name };
    if (path) body.path = path;
    if (gitignoreTemplate) body.gitignoreTemplate = gitignoreTemplate;
    if (generateReadme) body.generateReadme = generateReadme;
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

  async function handleArchiveProject(id: string) {
    const project = projects.find((p) => p.id === id);
    await apiFetch(`/api/projects/${id}/archive`, { method: "POST" });
    if (activeProjectId === id) {
      const remaining = projects.filter((p) => p.id !== id);
      if (remaining.length > 0) {
        await handleProjectChange(remaining[0].id);
      } else {
        setActiveProjectId(null);
      }
    }
    await loadProjects();
    showToast(`Archived "${project?.name ?? "project"}"`, "success");
  }

  async function handleUnarchiveProject(id: string) {
    const project = archivedProjects.find((p) => p.id === id);
    await apiFetch(`/api/projects/${id}/unarchive`, { method: "POST" });
    await loadProjects();
    await handleProjectChange(id);
    showToast(`Restored "${project?.name ?? "project"}"`, "success");
  }

  async function handleCreateIssue(data: CreateIssuePayload) {
    await runCreateIssueFlow(data, {
      columns,
      columnsRef,
      pendingBoardRefreshRef,
      activeProject,
      setMutating,
      setError,
      setColumns,
      setCreatingInColumnId,
      setExpandedCreatePanel,
      setPendingIssueIds,
      setPendingWorkspaceIssueIds,
      setWorkspaceIssue,
      setWorkspaceInitial,
      refetchBoard,
    });
  }

  async function handleUpdateIssue(id: string, data: UpdateIssueRequest) {
    setMutating(true);
    setError(null);
    try {
      await apiFetch(`/api/issues/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
      await refetchBoard();
      showToast("Issue updated", "success");
    } catch {
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
    } catch {
      showToast("Failed to delete issue", "error");
    } finally {
      setMutating(false);
    }
  }

  const { handleQuickPriorityChange, handleQuickAddTag, handleQuickRemoveTag, handleQuickTogglePinned } =
    createQuickUpdateHandlers({ columnsRef, setColumns, allTags, refetchBoard });

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

  function handleSwimlaneChange(dim: "none" | "priority" | "tag") {
    setSwimlaneDimension(dim);
    try { localStorage.setItem("kanban-swimlane", dim); } catch {}
  }

  async function handleDropWithLane(targetStatusId: string, laneKey: string, sortOrder?: number) {
    const raw = (window as unknown as Record<string, unknown>).__dragData;
    if (!raw || typeof raw !== "object") return;
    const { issueId } = raw as { issueId: string; sourceStatusId: string };
    if (!issueId) return;

    const lanePriority = swimlaneDimension === "priority" && laneKey !== "ungrouped" ? laneKey : undefined;
    const updateBody: Record<string, unknown> = { statusId: targetStatusId };
    if (sortOrder !== undefined) updateBody.sortOrder = sortOrder;
    if (lanePriority !== undefined) updateBody.priority = lanePriority;

    // Optimistic lane drop (status + lane priority) with exact-snapshot rollback.
    const snapshotColumns = columns;
    const movedIssue = columns.flatMap((c) => c.issues).find((i) => i.id === issueId);
    const targetColumn = columns.find((col) => col.id === targetStatusId);
    let optimistic = false;
    if (movedIssue && targetColumn) {
      const changedAt = new Date().toISOString();
      setColumns((prev) => {
        let next = moveIssueToStatus(prev, movedIssue, targetColumn, changedAt, sortOrder);
        if (lanePriority !== undefined) {
          next = next.map((col) =>
            col.id !== targetColumn.id
              ? col
              : { ...col, issues: col.issues.map((i) => (i.id === issueId ? { ...i, priority: lanePriority } : i)) },
          );
        }
        columnsRef.current = next;
        return next;
      });
      optimistic = true;
    }

    try {
      await apiFetch(`/api/issues/${issueId}`, { method: "PATCH", body: JSON.stringify(updateBody) });
      if (optimistic) {
        scheduleRefetch();
      } else {
        await refetchBoard();
      }
    } catch {
      if (optimistic) {
        setColumns(snapshotColumns);
        columnsRef.current = snapshotColumns;
      }
      showToast("Failed to move issue", "error");
    }
  }

  async function handleDrop(targetStatusId: string, sortOrder?: number) {
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

    const isReorder = sourceStatusId === targetStatusId && sortOrder !== undefined;
    const snapshotColumns = columns;
    const movedIssue = columns.flatMap((c) => c.issues).find((i) => i.id === issueId);
    let optimistic = false;
    if (isReorder) {
      const capturedIssueId = issueId;
      const capturedSortOrder = sortOrder;
      setColumns((prev) => applyLocalReorder(prev, targetStatusId, capturedIssueId, capturedSortOrder));
      optimistic = true;
    } else if (movedIssue && targetColumn) {
      // Optimistic cross-column move: the card lands in the target column
      // immediately; the PATCH + trailing coalesced refetch converge server
      // state behind it. (The MoveToDone confirm path above stays blocking.)
      moveIssueLocally(movedIssue, targetColumn, sortOrder);
      optimistic = true;
    }

    try {
      const body: UpdateIssueRequest = { statusId: targetStatusId };
      if (sortOrder !== undefined) body.sortOrder = sortOrder;
      await apiFetch(`/api/issues/${issueId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      if (optimistic) {
        scheduleRefetch();
      } else {
        await refetchBoard();
      }
    } catch {
      if (optimistic) {
        setColumns(snapshotColumns);
        columnsRef.current = snapshotColumns;
      }
      showToast("Failed to move issue", "error");
    }
  }

  async function handleColumnReorder(columnId: string, newSortOrder: number) {
    const snapshot = columns;
    setColumns((prev) =>
      prev
        .map((col) => (col.id === columnId ? { ...col, sortOrder: newSortOrder } : col))
        .sort((a, b) => a.sortOrder - b.sortOrder),
    );
    try {
      await apiFetch(`/api/projects/${activeProjectId}/statuses/${columnId}`, {
        method: "PATCH",
        body: JSON.stringify({ sortOrder: newSortOrder }),
      });
      await refetchBoard();
    } catch {
      setColumns(snapshot);
      showToast("Failed to reorder column", "error");
    }
  }

  async function handleMoveToNext(issue: IssueWithStatus, nextStatusId: string) {
    const targetColumn = columns.find((col) => col.id === nextStatusId);

    const doMove = async () => {
      const isArchiveTarget = targetColumn && ARCHIVE_STATUS_NAMES.has(targetColumn.name);
      if (isArchiveTarget) {
        const ws = issue.workspaceSummary?.main;
        if (ws && ws.status !== "closed") {
          // Intentionally blocking: MoveToDone is a confirm gate.
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
      // Optimistic move with exact-snapshot rollback. doMove may run later
      // (after the dependency-impact confirm), so snapshot the live columns
      // ref rather than this handler's render-time closure.
      const snapshotColumns = columnsRef.current;
      let optimistic = false;
      if (targetColumn) {
        moveIssueLocally(issue, targetColumn);
        optimistic = true;
      }
      try {
        await apiFetch(`/api/issues/${issue.id}`, { method: "PATCH", body: JSON.stringify({ statusId: nextStatusId }) });
        if (optimistic) {
          scheduleRefetch();
        } else {
          await refetchBoard();
        }
      } catch {
        if (optimistic) {
          setColumns(snapshotColumns);
          columnsRef.current = snapshotColumns;
        }
        showToast("Failed to move issue", "error");
      }
    };

    try {
      const depInfo = await apiFetch<DependencyInfo>(`/api/issues/${issue.id}/dependencies`);
      if (depInfo.dependencies.length > 0 && targetColumn) {
        setDependencyImpactPending({
          issue,
          toStatusId: nextStatusId,
          toStatusName: targetColumn.name,
          dependencies: depInfo.dependencies,
          confirm: async () => {
            setDependencyImpactPending(null);
            await doMove();
          },
        });
        return;
      }
    } catch {
      // If dependency fetch fails, proceed without the preview
    }

    await doMove();
  }

  function moveIssueLocally(issue: IssueWithStatus, targetStatus: StatusWithIssues, sortOrder?: number) {
    const changedAt = new Date().toISOString();
    setColumns((prev) => {
      const next = moveIssueToStatus(prev, issue, targetStatus, changedAt, sortOrder);
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
    if (pendingIssueIds.has(issue.id)) return;
    setSelectedIssue(issue);
    setKeyboardCursorIssueId(null);
  }

  function handleManageWorkspaces(issue: IssueWithStatus, workspaceId?: string, sessionId = "") {
    setSelectedIssue(null);
    setWorkspaceIssue(issue);
    setWorkspaceOpenCreate(false);
    setWorkspaceInitialDiff(false);
    if (workspaceId) {
      setWorkspaceInitial({ workspaceId, sessionId });
    }
  }

  function handleOpenDiff(issue: IssueWithStatus, workspaceId: string) {
    setSelectedIssue(null);
    setWorkspaceIssue(issue);
    setWorkspaceOpenCreate(false);
    setWorkspaceInitialDiff(true);
    setWorkspaceInitial({ workspaceId, sessionId: "" });
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

  async function handleDropOnAgentSlot(issue: IssueWithStatus) {
    if (!activeProject) return;

    // Guard: reject if already at or over capacity
    const activeCount = columns
      .flatMap((col) => col.issues)
      .filter((i) => {
        const s = i.workspaceSummary?.main?.status;
        return s === "active" || s === "fixing";
      }).length;
    if (activeAgentsTarget !== undefined && activeCount >= activeAgentsTarget) {
      showToast(`Agent capacity reached (${activeAgentsTarget} active). Stop a running workspace first.`, "error");
      return;
    }

    setPendingWorkspaceIssueIds((prev) => new Set([...prev, issue.id]));
    try {
      const s = await getSettings();
      const provider = (s.provider as "claude" | "codex" | "copilot") || "claude";
      const profileName = provider === "codex"
        ? (s.codex_profile || "default")
        : provider === "copilot"
        ? (s.copilot_profile || "default")
        : (s.claude_profile || "default");

      const branch = suggestBranchName(issue);
      const body: Record<string, unknown> = {
        issueId: issue.id,
        branch,
        requiresReview: s.auto_review !== "false",
        planMode: issue.priority === "high" || issue.priority === "critical",
        isDirect: false,
        profile: { provider, name: profileName },
      };
      if (s.default_model) body.model = s.default_model;

      const result = await apiFetch<{ id: string; sessionId?: string }>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify(body),
      });
      await refetchBoard();
      // Open the new workspace in the panel
      setWorkspaceIssue(issue);
      setWorkspaceInitial({ workspaceId: result.id, sessionId: result.sessionId ?? "" });
      setWorkspaceOpenCreate(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to start workspace", "error");
    } finally {
      setPendingWorkspaceIssueIds((prev) => {
        const next = new Set(prev);
        next.delete(issue.id);
        return next;
      });
    }
  }

  const [showBlocked, setShowBlocked] = useState(false);
  const [showStaleOnly, setShowStaleOnly] = useState(false);

  const statusFilter = useMemo(
    () => columns.find((col) => col.id === statusFilterId) ?? null,
    [columns, statusFilterId],
  );
  const boardViewState: BoardViewState = useMemo(() => {
    const firstTagId = activeTagIds.size === 1 ? [...activeTagIds][0] : null;
    const firstTag = firstTagId ? allTags.find((t) => t.id === firstTagId) ?? null : null;
    return {
      searchQuery,
      showBlocked,
      showStaleOnly,
      statusId: statusFilter?.id ?? null,
      statusName: statusFilter?.name ?? null,
      tagId: firstTag?.id ?? null,
      tagName: firstTag?.name ?? null,
      sortMode: "rank",
      viewMode,
    };
  }, [activeTagIds, allTags, searchQuery, showBlocked, showStaleOnly, statusFilter, viewMode]);
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
    setSearchQuery(state.searchQuery);
    setShowBlocked(state.showBlocked);
    setShowStaleOnly(state.showStaleOnly);
    setStatusFilterId(state.statusId);
    setActiveTagIds(state.tagId ? new Set([state.tagId]) : new Set());
    handleViewModeChange(state.viewMode);
  }, [handleViewModeChange]);

  const filterOptions = useMemo(() => ({
    focusMode,
    statusFilterId,
    activeTagIds,
    milestoneFilterId,
    issueTypeFilter,
    showBlocked,
    showStaleOnly,
    searchQuery,
  }), [focusMode, statusFilterId, activeTagIds, milestoneFilterId, issueTypeFilter, showBlocked, showStaleOnly, searchQuery]);

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
      const result = await apiFetch<{ id: string; issueNumber: number; title: string }>(
        `/api/issues/${issue.id}/duplicate`,
        { method: "POST" },
      );
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
        {viewMode === "graph" && activeProjectId ? (
          <div className="flex-1 min-h-0">
            <BoardErrorBoundary columnName="Graph View">
              <GraphView
                columns={columns}
                projectId={activeProjectId}
                onIssueClick={handleIssueClick}
                searchQuery={searchQuery}
                focusIssueId={graphFocusIssueId}
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
              onGoToBoard={() => handleViewModeChange("kanban")}
              activeAgentsTarget={activeAgentsTarget}
              onDropIssue={canStartWorkspace ? handleDropOnAgentSlot : undefined}
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
        {viewMode === "activity" && activeProjectId && (
          <BoardErrorBoundary columnName="Activity Feed">
            <ActivityFeedView
              projectId={activeProjectId}
              onIssueClick={(issueId) => {
                const issue = columns.flatMap(c => c.issues).find(i => i.id === issueId);
                if (issue) handleIssueClick(issue);
              }}
            />
          </BoardErrorBoundary>
        )}
        {viewMode === "stale-work" && activeProjectId && (
          <BoardErrorBoundary columnName="Stale Work">
            <StaleWorkDashboard
              projectId={activeProjectId}
              onIssueClick={handleIssueClick}
            />
          </BoardErrorBoundary>
        )}
        {viewMode === "throughput" && activeProjectId && (
          <BoardErrorBoundary columnName="Throughput">
            <ThroughputChart projectId={activeProjectId} />
          </BoardErrorBoundary>
        )}
        {viewMode === "provider-mix" && activeProjectId && (
          <BoardErrorBoundary columnName="Provider Mix">
            <ProviderMixChart projectId={activeProjectId} />
          </BoardErrorBoundary>
        )}
        {viewMode === "lead-time" && activeProjectId && (
          <BoardErrorBoundary columnName="Lead Time Trend">
            <LeadTimeTrendChart projectId={activeProjectId} />
          </BoardErrorBoundary>
        )}
        {viewMode === "scorecard-distribution" && activeProjectId && (
          <BoardErrorBoundary columnName="Score Distribution">
            <ScorecardDistributionChart projectId={activeProjectId} />
          </BoardErrorBoundary>
        )}
        {viewMode === "provider-cost" && activeProjectId && (
          <BoardErrorBoundary columnName="Provider Cost Over Time">
            <ProviderCostOverTimeChart projectId={activeProjectId} />
          </BoardErrorBoundary>
        )}
        {viewMode === "agent-throughput" && activeProjectId && (
          <BoardErrorBoundary columnName="Agent Throughput Leaderboard">
            <AgentThroughputLeaderboard projectId={activeProjectId} />
          </BoardErrorBoundary>
        )}
        {viewMode === "burndown" && activeProjectId && (
          <BoardErrorBoundary columnName="Burndown">
            <BurndownChart projectId={activeProjectId} />
          </BoardErrorBoundary>
        )}
        {viewMode === "calendar" && (
          <BoardErrorBoundary columnName="Calendar">
            <CalendarView
              columns={columns}
              onIssueClick={handleIssueClick}
              searchQuery={searchQuery}
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
        {viewMode === "runbooks" && (
          <BoardErrorBoundary columnName="Runbooks">
            <RunbooksView projectId={activeProjectId} />
          </BoardErrorBoundary>
        )}
        {viewMode === "monitor-history" && activeProjectId && (
          <BoardErrorBoundary columnName="Monitor History">
            <MonitorCycleHistoryPanel projectId={activeProjectId} />
          </BoardErrorBoundary>
        )}
        {viewMode === "health-events" && activeProjectId && (
          <BoardErrorBoundary columnName="Board Health Events">
            <BoardHealthNotificationCenter
              projectId={activeProjectId}
              onOpenIssue={(issueNumber) => {
                const issue = columns.flatMap(c => c.issues).find(i => i.issueNumber === issueNumber);
                if (issue) {
                  handleViewModeChange("kanban");
                  handleIssueClick(issue);
                }
              }}
            />
          </BoardErrorBoundary>
        )}
        {viewMode === "drive" && activeProjectId && (
          <BoardErrorBoundary columnName="Drive Dashboard">
            <DriveDashboard
              projectId={activeProjectId}
              onIssueClick={(issueId) => {
                const issue = columns.flatMap(c => c.issues).find(i => i.id === issueId);
                if (issue) {
                  handleViewModeChange("kanban");
                  handleIssueClick(issue);
                }
              }}
            />
          </BoardErrorBoundary>
        )}
        {viewMode === "capacity" && activeProjectId && (
          <BoardErrorBoundary columnName="Sprint Capacity Planner">
            <SprintCapacityPlanner projectId={activeProjectId} />
          </BoardErrorBoundary>
        )}
        {viewMode === "constellation" && (
          <BoardErrorBoundary columnName="Constellation View">
            <ConstellationView
              columns={columns}
              onIssueClick={handleIssueClick}
              searchQuery={searchQuery}
            />
          </BoardErrorBoundary>
        )}
        {viewMode === "momentum" && (
          <BoardErrorBoundary columnName="Momentum View">
            <MomentumView
              columns={columns}
              onIssueClick={handleIssueClick}
              searchQuery={searchQuery}
            />
          </BoardErrorBoundary>
        )}
        {viewMode === "fireworks" && (
          <BoardErrorBoundary columnName="Fireworks View">
            <FireworksView
              columns={columns}
              onIssueClick={handleIssueClick}
              searchQuery={searchQuery}
            />
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
            <BoardFilterMenu
              statuses={boardStatusOptions}
              statusFilterId={statusFilterId}
              onStatusFilterChange={setStatusFilterId}
              issueTypeFilter={issueTypeFilter}
              onIssueTypeFilterChange={handleIssueTypeFilterChange}
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
