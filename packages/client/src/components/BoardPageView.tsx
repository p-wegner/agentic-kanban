// Presentational render for BoardPage (container/presenter split). All state,
// handlers and derived values are threaded in via props with the SAME names as
// the container's locals (passed by shorthand spread, so mis-pairing is
// impossible), making the JSX below a verbatim, behaviour-preserving move.
// Props are typed from their real producers (domain types, `ReturnType<typeof
// useX>`, `Dispatch<SetStateAction>`) so the spread is fully type-checked — no
// `any`.
import { lazy, Suspense } from "react";
import { Layout } from "./Layout.js";
import { BacklogView } from "./BacklogView.js";
import { MilestoneFilterBanner } from "./MilestoneFilterBanner.js";
import { BoardSecondaryViews } from "./BoardSecondaryViews.js";
import { BoardKanbanView } from "./BoardKanbanView.js";
import { RecentlyMergedStrip } from "./RecentlyMergedStrip.js";
import { BoardStats } from "./BoardStats.js";
import { BoardToolbar } from "./BoardToolbar.js";
import { BoardFilterMenu } from "./BoardFilterMenu.js";
import { SavedBoardViews } from "./SavedBoardViews.js";
import { ExportImportMenu } from "./ExportImportMenu.js";
import { BoardErrorBoundary } from "./BoardErrorBoundary.js";
import { ToastContainer } from "./Toast.js";
import { BoardBulkActionBar } from "./BoardBulkActionBar.js";
import { AgentLiveTickerPanel } from "./AgentLiveTickerPanel.js";
import { SkeletonBoard } from "./SkeletonBoard.js";
import { ViewLoadingFallback } from "./ViewLoadingFallback.js";
import { MentionProvider } from "../lib/MentionContext.js";
import { useBoardSelectionStore } from "../stores/boardSelectionStore.js";
import type { Dispatch, MouseEvent as ReactMouseEvent, MutableRefObject, SetStateAction } from "react";
import type {
  IssueWithStatus,
  StatusWithIssues,
  MilestoneResponse,
} from "@agentic-kanban/shared";
import type { ApprovalRequest, LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";
import type { BoardViewState, SavedViewReference } from "../lib/boardSavedViews.js";
import type { Theme } from "../hooks/useTheme.js";
import type { NotificationEvent } from "../hooks/useActivityNotifications.js";
import type {
  Project,
  Tag,
  MoveToDonePending,
  DependencyImpactPending,
  ExpandedCreatePanel,
} from "../routes/BoardPage.js";
// Hook/factory return shapes — type-only (erased), so the props stay exactly in
// sync with the container's producers without runtime imports or coupling.
import type { useBoardFilters } from "../hooks/useBoardFilters.js";
import type { useBoardPanelNavigation } from "../hooks/useBoardPanelNavigation.js";
import type { useProjectManagement } from "../hooks/useProjectManagement.js";
import type { createBoardIssueActions } from "../hooks/createBoardIssueActions.js";
import type { useBoardMiscHandlers } from "../hooks/useBoardMiscHandlers.js";
import type { useBoardNavigation } from "../hooks/useBoardNavigation.js";
import type { useBoardIssueMovement } from "../hooks/useBoardIssueMovement.js";
import type { useBoardPanels } from "../hooks/useBoardPanels.js";
import type { useBoardPreferences } from "../hooks/useBoardPreferences.js";
import type { useActivityNotifications } from "../hooks/useActivityNotifications.js";
import type { useAgentLiveTicker } from "../hooks/useAgentLiveTicker.js";
import type { useBoardBulkSelection } from "../hooks/useBoardBulkSelection.js";
import type { useBoardPageRoute } from "../routes/useBoardPageRoute.js";
import type { useColumnResize } from "../lib/columnResizeHandler.js";
import type { createQuickUpdateHandlers } from "../lib/issueQuickUpdates.js";
import type { buildRunQueueForecast } from "./RunQueueForecastPanel.js";

type Filters = ReturnType<typeof useBoardFilters>;
type PanelNav = ReturnType<typeof useBoardPanelNavigation>;
type ProjectMgmt = ReturnType<typeof useProjectManagement>;
type IssueActions = ReturnType<typeof createBoardIssueActions>;
type Misc = ReturnType<typeof useBoardMiscHandlers>;
type Nav = ReturnType<typeof useBoardNavigation>;
type Movement = ReturnType<typeof useBoardIssueMovement>;
type Route = ReturnType<typeof useBoardPageRoute>;
type ColumnResize = ReturnType<typeof useColumnResize>;
type QuickUpdates = ReturnType<typeof createQuickUpdateHandlers>;

type StatusOption = { id: string; name: string };

const IssueDetailPanel = lazy(() => import("./IssueDetailPanel.js").then((m) => ({ default: m.IssueDetailPanel })));
const WorkspacePanel = lazy(() => import("./WorkspacePanel.js").then((m) => ({ default: m.WorkspacePanel })));
const BoardOverlayPanels = lazy(() => import("./BoardOverlayPanels.js").then((m) => ({ default: m.BoardOverlayPanels })));

interface BoardPageViewModel {
  activeAgentsTarget: number | undefined;
  activeColumns: StatusWithIssues[];
  activeProject: Project | undefined;
  // BoardPageView is only rendered after BoardPage's `!activeProjectId` guard,
  // which control-flow-narrows this to a non-null string.
  activeProjectId: string;
  activeTagIds: Filters["activeTagIds"];
  agentQuestionsCount: number;
  allMentionIssues: { id: string; issueNumber: number | null; title: string }[];
  allTags: Tag[];
  applyBoardViewState: (state: BoardViewState) => void;
  approvalRequests: ApprovalRequest[];
  archiveColumns: StatusWithIssues[];
  archivedProjects: Project[];
  backlogColumn: StatusWithIssues | undefined;
  boardStatusOptions: StatusOption[];
  boardTagOptions: StatusOption[];
  boardViewState: BoardViewState;
  bulk: ReturnType<typeof useBoardBulkSelection>;
  butlerInitialPrompt: string | null;
  canStartWorkspace: boolean;
  collapsedGroups: Set<string>;
  columnWidths: ColumnResize["columnWidths"];
  columns: StatusWithIssues[];
  columnsRef: MutableRefObject<StatusWithIssues[]>;
  createdDateFilter: string | null;
  creatingInColumnId: string | null;
  dependencyImpactPending: DependencyImpactPending;
  error: string | null;
  expandedCreatePanel: ExpandedCreatePanel;
  focusMode: boolean;
  graphFocusIssueId: Route["graphFocusIssueId"];
  handleArchiveProject: ProjectMgmt["handleArchiveProject"];
  handleBoardDragStart: Movement["handleBoardDragStart"];
  handleBoardIssueClick: (issue: IssueWithStatus, event: ReactMouseEvent) => void;
  handleChatAboutTicket: PanelNav["handleChatAboutTicket"];
  handleClearTagFilter: Filters["handleClearTagFilter"];
  handleColumnReorder: Movement["handleColumnReorder"];
  handleColumnResizeStart: ColumnResize["handleColumnResizeStart"];
  handleCreateIssue: IssueActions["handleCreateIssue"];
  handleCreateProject: ProjectMgmt["handleCreateProject"];
  handleCreatedDateDrilldown: Misc["handleCreatedDateDrilldown"];
  handleDeleteIssue: IssueActions["handleDeleteIssue"];
  handleDrop: Movement["handleDrop"];
  handleDropOnAgentSlot: IssueActions["handleDropOnAgentSlot"];
  handleDropWithLane: Movement["handleDropWithLane"];
  handleDuplicateIssue: Misc["handleDuplicateIssue"];
  handleIssueClick: PanelNav["handleIssueClick"];
  handleIssueTypeFilterChange: Filters["handleIssueTypeFilterChange"];
  handleManageWorkspaces: PanelNav["handleManageWorkspaces"];
  handleMentionClick: Misc["handleMentionClick"];
  handleMilestoneOverviewClick: (milestoneId: string) => void;
  handleMoveToNext: Movement["handleMoveToNext"];
  handleNotificationEventClick: (event: NotificationEvent) => void;
  handleOpenDiff: PanelNav["handleOpenDiff"];
  handleOpenWorkspaceById: PanelNav["handleOpenWorkspaceById"];
  handlePriorityFilterChange: Filters["handlePriorityFilterChange"];
  handleProjectChange: ProjectMgmt["handleProjectChange"];
  handlePromoteBacklogIssue: Movement["handlePromoteBacklogIssue"];
  handleQuickAddTag: QuickUpdates["handleQuickAddTag"];
  handleQuickPriorityChange: QuickUpdates["handleQuickPriorityChange"];
  handleQuickRemoveTag: QuickUpdates["handleQuickRemoveTag"];
  handleQuickTogglePinned: QuickUpdates["handleQuickTogglePinned"];
  handleRegisterProject: ProjectMgmt["handleRegisterProject"];
  handleStartWorkspace: PanelNav["handleStartWorkspace"];
  handleSwimlaneChange: Movement["handleSwimlaneChange"];
  handleTagFilterToggle: Filters["handleTagFilterToggle"];
  handleUnarchiveProject: ProjectMgmt["handleUnarchiveProject"];
  handleUnregisterProject: ProjectMgmt["handleUnregisterProject"];
  handleUpdateIssue: IssueActions["handleUpdateIssue"];
  handleViewModeChange: Route["handleViewModeChange"];
  isDark: boolean;
  issueTypeFilter: Filters["issueTypeFilter"];
  keyboardCursorIssueId: string | null;
  liveStats: Record<string, LiveSessionStats>;
  loadSavedViewTags: () => Promise<SavedViewReference[]>;
  loadTags: () => Promise<SavedViewReference[]>;
  milestoneFilterId: string | null;
  milestones: MilestoneResponse[];
  moveToDonePending: MoveToDonePending;
  mutating: boolean;
  notifications: ReturnType<typeof useActivityNotifications>;
  openIssueById: Nav["openIssueById"];
  panels: ReturnType<typeof useBoardPanels>;
  pendingIssueIds: Set<string>;
  pendingWorkspaceIssueIds: Set<string>;
  prefs: ReturnType<typeof useBoardPreferences>;
  priorityFilter: Filters["priorityFilter"];
  projects: Project[];
  refetchBoard: (projectId?: string, options?: { force?: boolean }) => Promise<StatusWithIssues[] | undefined>;
  resetColumnWidth: ColumnResize["resetColumnWidth"];
  runQueueForecast: ReturnType<typeof buildRunQueueForecast>;
  searchQuery: string;
  sessionActivity: Record<string, string>;
  sessionTodos: Record<string, TodoItem[]>;
  setApprovalRequests: Dispatch<SetStateAction<ApprovalRequest[]>>;
  setButlerInitialPrompt: Dispatch<SetStateAction<string | null>>;
  setCreatedDateFilter: Dispatch<SetStateAction<string | null>>;
  setCreatingInColumnId: Dispatch<SetStateAction<string | null>>;
  setDependencyImpactPending: Dispatch<SetStateAction<DependencyImpactPending>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setExpandedCreatePanel: Dispatch<SetStateAction<ExpandedCreatePanel>>;
  setFocusMode: Dispatch<SetStateAction<boolean>>;
  setGraphFocusIssueId: Route["setGraphFocusIssueId"];
  setMilestoneFilterId: Dispatch<SetStateAction<string | null>>;
  setMoveToDonePending: Dispatch<SetStateAction<MoveToDonePending>>;
  setPendingWorkspaceIssueIds: Dispatch<SetStateAction<Set<string>>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  setShowBlocked: Dispatch<SetStateAction<boolean>>;
  setShowStaleOnly: Dispatch<SetStateAction<boolean>>;
  setStatusFilterId: Dispatch<SetStateAction<string | null>>;
  setTheme: (theme: Theme) => void;
  showBlocked: boolean;
  showStaleOnly: boolean;
  statusFilterId: string | null;
  swimlaneDimension: Movement["swimlaneDimension"];
  switchingProject: boolean;
  tickerEntries: ReturnType<typeof useAgentLiveTicker>;
  toggleGroup: Misc["toggleGroup"];
  trailControls: Nav["trailControls"];
  viewMode: Route["viewMode"];
  visibilityColumns: StatusWithIssues[];
}

type ProjectController = Pick<BoardPageViewModel,
  "activeProject" | "activeProjectId" | "archivedProjects" | "projects" | "switchingProject" |
  "handleArchiveProject" | "handleCreateProject" | "handleProjectChange" | "handleRegisterProject" |
  "handleUnarchiveProject" | "handleUnregisterProject"
>;
type BoardDataController = Pick<BoardPageViewModel,
  "activeAgentsTarget" | "activeColumns" | "allMentionIssues" | "allTags" | "archiveColumns" |
  "backlogColumn" | "boardStatusOptions" | "boardTagOptions" | "boardViewState" | "bulk" |
  "canStartWorkspace" | "collapsedGroups" | "columnWidths" | "columns" | "columnsRef" |
  "creatingInColumnId" | "expandedCreatePanel" | "keyboardCursorIssueId" | "milestones" |
  "pendingIssueIds" | "pendingWorkspaceIssueIds" | "runQueueForecast" | "visibilityColumns"
>;
type FilterNavigationController = Pick<BoardPageViewModel,
  "activeTagIds" | "applyBoardViewState" | "createdDateFilter" | "focusMode" |
  "handleClearTagFilter" | "handleIssueTypeFilterChange" | "handleMilestoneOverviewClick" |
  "handlePriorityFilterChange" | "handleTagFilterToggle" | "issueTypeFilter" |
  "loadSavedViewTags" | "loadTags" | "milestoneFilterId" | "priorityFilter" | "searchQuery" |
  "setCreatedDateFilter" | "setFocusMode" | "setMilestoneFilterId" | "setSearchQuery" |
  "setShowBlocked" | "setShowStaleOnly" | "setStatusFilterId" | "showBlocked" |
  "showStaleOnly" | "statusFilterId"
>;
type WorkspaceController = Pick<BoardPageViewModel,
  "butlerInitialPrompt" | "setButlerInitialPrompt"
>;
type RealtimeController = Pick<BoardPageViewModel,
  "agentQuestionsCount" | "approvalRequests" | "handleNotificationEventClick" | "liveStats" |
  "notifications" | "sessionActivity" | "sessionTodos" | "setApprovalRequests" | "tickerEntries"
>;
type BoardCommandController = Pick<BoardPageViewModel,
  "handleBoardDragStart" | "handleBoardIssueClick" | "handleChatAboutTicket" |
  "handleColumnReorder" | "handleColumnResizeStart" | "handleCreateIssue" |
  "handleCreatedDateDrilldown" | "handleDeleteIssue" | "handleDrop" | "handleDropOnAgentSlot" |
  "handleDropWithLane" | "handleDuplicateIssue" | "handleIssueClick" |
  "handleManageWorkspaces" | "handleMentionClick" | "handleMoveToNext" | "handleOpenDiff" |
  "handleOpenWorkspaceById" | "handlePromoteBacklogIssue" | "handleQuickAddTag" |
  "handleQuickPriorityChange" | "handleQuickRemoveTag" | "handleQuickTogglePinned" |
  "handleStartWorkspace" | "handleSwimlaneChange" | "handleUpdateIssue" |
  "handleViewModeChange" | "openIssueById" | "refetchBoard" | "resetColumnWidth" |
  "swimlaneDimension" | "toggleGroup" | "trailControls" | "viewMode"
>;
type BoardChromeController = Pick<BoardPageViewModel,
  "dependencyImpactPending" | "error" | "graphFocusIssueId" | "isDark" | "moveToDonePending" |
  "mutating" | "panels" | "prefs" | "setCreatingInColumnId" | "setDependencyImpactPending" |
  "setError" | "setExpandedCreatePanel" | "setGraphFocusIssueId" | "setMoveToDonePending" |
  "setPendingWorkspaceIssueIds" | "setTheme"
>;

interface BoardPageViewProps {
  board: BoardDataController;
  chrome: BoardChromeController;
  commands: BoardCommandController;
  filters: FilterNavigationController;
  project: ProjectController;
  realtime: RealtimeController;
  workspace: WorkspaceController;
}

export function BoardPageView({ board, chrome, commands, filters, project, realtime, workspace }: BoardPageViewProps) {
  const {
    activeAgentsTarget, activeColumns, allMentionIssues, allTags, archiveColumns, backlogColumn,
    boardStatusOptions, boardTagOptions, boardViewState, bulk, canStartWorkspace, collapsedGroups,
    columnWidths, columns, columnsRef, creatingInColumnId, expandedCreatePanel, keyboardCursorIssueId,
    milestones, pendingIssueIds, pendingWorkspaceIssueIds, runQueueForecast, visibilityColumns,
  } = board;
  const {
    dependencyImpactPending, error, graphFocusIssueId, isDark, moveToDonePending, mutating, panels,
    prefs, setCreatingInColumnId, setDependencyImpactPending, setError, setExpandedCreatePanel,
    setGraphFocusIssueId, setMoveToDonePending, setPendingWorkspaceIssueIds, setTheme,
  } = chrome;
  const {
    handleBoardDragStart, handleBoardIssueClick, handleChatAboutTicket, handleColumnReorder,
    handleColumnResizeStart, handleCreateIssue, handleCreatedDateDrilldown, handleDeleteIssue,
    handleDrop, handleDropOnAgentSlot, handleDropWithLane, handleDuplicateIssue, handleIssueClick,
    handleManageWorkspaces, handleMentionClick, handleMoveToNext, handleOpenDiff,
    handleOpenWorkspaceById, handlePromoteBacklogIssue, handleQuickAddTag, handleQuickPriorityChange,
    handleQuickRemoveTag, handleQuickTogglePinned, handleStartWorkspace, handleSwimlaneChange,
    handleUpdateIssue, handleViewModeChange, openIssueById, refetchBoard, resetColumnWidth,
    swimlaneDimension, toggleGroup, trailControls, viewMode,
  } = commands;
  const {
    activeTagIds, applyBoardViewState, createdDateFilter, focusMode, handleClearTagFilter,
    handleIssueTypeFilterChange, handleMilestoneOverviewClick, handlePriorityFilterChange,
    handleTagFilterToggle, issueTypeFilter, loadSavedViewTags, loadTags, milestoneFilterId,
    priorityFilter, searchQuery, setCreatedDateFilter, setFocusMode, setMilestoneFilterId,
    setSearchQuery, setShowBlocked, setShowStaleOnly, setStatusFilterId, showBlocked,
    showStaleOnly, statusFilterId,
  } = filters;
  const {
    activeProject, activeProjectId, archivedProjects, handleArchiveProject, handleCreateProject,
    handleProjectChange, handleRegisterProject, handleUnarchiveProject, handleUnregisterProject,
    projects, switchingProject,
  } = project;
  const {
    agentQuestionsCount, approvalRequests, handleNotificationEventClick, liveStats, notifications,
    sessionActivity, sessionTodos, setApprovalRequests, tickerEntries,
  } = realtime;
  const { butlerInitialPrompt, setButlerInitialPrompt } = workspace;
  // Selection slice (#905) — read reactively from the board store instead of via
  // props. The orchestration hooks write to the same store, so these stay in sync.
  const selectedIssue = useBoardSelectionStore((s) => s.selectedIssue);
  const workspaceIssue = useBoardSelectionStore((s) => s.workspaceIssue);
  const workspaceInitial = useBoardSelectionStore((s) => s.workspaceInitial);
  const workspaceInitialDiff = useBoardSelectionStore((s) => s.workspaceInitialDiff);
  const workspaceOpenCreate = useBoardSelectionStore((s) => s.workspaceOpenCreate);
  const setSelectedIssue = useBoardSelectionStore((s) => s.setSelectedIssue);
  const setWorkspaceIssue = useBoardSelectionStore((s) => s.setWorkspaceIssue);
  const setWorkspaceInitial = useBoardSelectionStore((s) => s.setWorkspaceInitial);
  const setWorkspaceInitialDiff = useBoardSelectionStore((s) => s.setWorkspaceInitialDiff);
  const setWorkspaceOpenCreate = useBoardSelectionStore((s) => s.setWorkspaceOpenCreate);
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
          void refetchBoard();
        }}
        activeProjectId={activeProjectId}
        columns={columns}
        nudgeWipLimit={prefs.nudgeWipLimit}
        viewMode={viewMode}
        columnsRef={columnsRef}
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
