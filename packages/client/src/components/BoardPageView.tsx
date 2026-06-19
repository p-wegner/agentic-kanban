/* eslint-disable @typescript-eslint/no-explicit-any */
// Presentational render for BoardPage (container/presenter split). All state,
// handlers and derived values are threaded in via props with the SAME names as
// the container's locals (passed by shorthand spread, so mis-pairing is
// impossible), making the JSX below a verbatim, behaviour-preserving move.
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
const IssueDetailPanel = lazy(() => import("./IssueDetailPanel.js").then((m) => ({ default: m.IssueDetailPanel })));
const WorkspacePanel = lazy(() => import("./WorkspacePanel.js").then((m) => ({ default: m.WorkspacePanel })));
const BoardOverlayPanels = lazy(() => import("./BoardOverlayPanels.js").then((m) => ({ default: m.BoardOverlayPanels })));

interface BoardPageViewProps {
  activeAgentsTarget: any;
  activeColumns: any;
  activeProject: any;
  activeProjectId: any;
  activeTagIds: any;
  agentQuestionsCount: any;
  allMentionIssues: any;
  allTags: any;
  applyBoardViewState: any;
  approvalRequests: any;
  archiveColumns: any;
  archivedProjects: any;
  backlogColumn: any;
  boardStatusOptions: any;
  boardTagOptions: any;
  boardViewState: any;
  bulk: any;
  butlerInitialPrompt: any;
  canStartWorkspace: any;
  collapsedGroups: any;
  columnWidths: any;
  columns: any;
  columnsRef: any;
  createdDateFilter: any;
  creatingInColumnId: any;
  dependencyImpactPending: any;
  error: any;
  expandedCreatePanel: any;
  focusMode: any;
  graphFocusIssueId: any;
  handleArchiveProject: any;
  handleBoardDragStart: any;
  handleBoardIssueClick: any;
  handleChatAboutTicket: any;
  handleClearTagFilter: any;
  handleColumnReorder: any;
  handleColumnResizeStart: any;
  handleCreateIssue: any;
  handleCreateProject: any;
  handleCreatedDateDrilldown: any;
  handleDeleteIssue: any;
  handleDrop: any;
  handleDropOnAgentSlot: any;
  handleDropWithLane: any;
  handleDuplicateIssue: any;
  handleIssueClick: any;
  handleIssueTypeFilterChange: any;
  handleManageWorkspaces: any;
  handleMentionClick: any;
  handleMilestoneOverviewClick: any;
  handleMoveToNext: any;
  handleNotificationEventClick: any;
  handleOpenDiff: any;
  handleOpenWorkspaceById: any;
  handlePriorityFilterChange: any;
  handleProjectChange: any;
  handlePromoteBacklogIssue: any;
  handleQuickAddTag: any;
  handleQuickPriorityChange: any;
  handleQuickRemoveTag: any;
  handleQuickTogglePinned: any;
  handleRegisterProject: any;
  handleStartWorkspace: any;
  handleSwimlaneChange: any;
  handleTagFilterToggle: any;
  handleUnarchiveProject: any;
  handleUnregisterProject: any;
  handleUpdateIssue: any;
  handleViewModeChange: any;
  isDark: any;
  issueTypeFilter: any;
  keyboardCursorIssueId: any;
  liveStats: any;
  loadSavedViewTags: any;
  loadTags: any;
  milestoneFilterId: any;
  milestones: any;
  moveToDonePending: any;
  mutating: any;
  notifications: any;
  openIssueById: any;
  panels: any;
  pendingIssueIds: any;
  pendingWorkspaceIssueIds: any;
  prefs: any;
  priorityFilter: any;
  projects: any;
  refetchBoard: any;
  resetColumnWidth: any;
  runQueueForecast: any;
  searchQuery: any;
  selectedIssue: any;
  sessionActivity: any;
  sessionTodos: any;
  setApprovalRequests: any;
  setButlerInitialPrompt: any;
  setCreatedDateFilter: any;
  setCreatingInColumnId: any;
  setDependencyImpactPending: any;
  setError: any;
  setExpandedCreatePanel: any;
  setFocusMode: any;
  setGraphFocusIssueId: any;
  setMilestoneFilterId: any;
  setMoveToDonePending: any;
  setPendingWorkspaceIssueIds: any;
  setSearchQuery: any;
  setSelectedIssue: any;
  setShowBlocked: any;
  setShowStaleOnly: any;
  setStatusFilterId: any;
  setTheme: any;
  setWorkspaceInitial: any;
  setWorkspaceInitialDiff: any;
  setWorkspaceIssue: any;
  setWorkspaceOpenCreate: any;
  showBlocked: any;
  showStaleOnly: any;
  statusFilterId: any;
  swimlaneDimension: any;
  switchingProject: any;
  tickerEntries: any;
  toggleGroup: any;
  trailControls: any;
  viewMode: any;
  visibilityColumns: any;
  workspaceInitial: any;
  workspaceInitialDiff: any;
  workspaceIssue: any;
  workspaceOpenCreate: any;
}

export function BoardPageView({
    activeAgentsTarget,   activeColumns,   activeProject,   activeProjectId,   activeTagIds,   
  agentQuestionsCount,   allMentionIssues,   allTags,   applyBoardViewState,   approvalRequests,   
  archiveColumns,   archivedProjects,   backlogColumn,   boardStatusOptions,   boardTagOptions,   
  boardViewState,   bulk,   butlerInitialPrompt,   canStartWorkspace,   collapsedGroups,   
  columnWidths,   columns,   columnsRef,   createdDateFilter,   creatingInColumnId,   
  dependencyImpactPending,   error,   expandedCreatePanel,   focusMode,   graphFocusIssueId,   
  handleArchiveProject,   handleBoardDragStart,   handleBoardIssueClick,   handleChatAboutTicket,   
  handleClearTagFilter,   handleColumnReorder,   handleColumnResizeStart,   handleCreateIssue,   
  handleCreateProject,   handleCreatedDateDrilldown,   handleDeleteIssue,   handleDrop,   
  handleDropOnAgentSlot,   handleDropWithLane,   handleDuplicateIssue,   handleIssueClick,   
  handleIssueTypeFilterChange,   handleManageWorkspaces,   handleMentionClick,   
  handleMilestoneOverviewClick,   handleMoveToNext,   handleNotificationEventClick,   handleOpenDiff, 
    handleOpenWorkspaceById,   handlePriorityFilterChange,   handleProjectChange,   
  handlePromoteBacklogIssue,   handleQuickAddTag,   handleQuickPriorityChange,   
  handleQuickRemoveTag,   handleQuickTogglePinned,   handleRegisterProject,   handleStartWorkspace,   
  handleSwimlaneChange,   handleTagFilterToggle,   handleUnarchiveProject,   handleUnregisterProject, 
    handleUpdateIssue,   handleViewModeChange,   isDark,   issueTypeFilter,   keyboardCursorIssueId,  
   liveStats,   loadSavedViewTags,   loadTags,   milestoneFilterId,   milestones,   
  moveToDonePending,   mutating,   notifications,   openIssueById,   panels,   pendingIssueIds,   
  pendingWorkspaceIssueIds,   prefs,   priorityFilter,   projects,   refetchBoard,   
  resetColumnWidth,   runQueueForecast,   searchQuery,   selectedIssue,   sessionActivity,   
  sessionTodos,   setApprovalRequests,   setButlerInitialPrompt,   setCreatedDateFilter,   
  setCreatingInColumnId,   setDependencyImpactPending,   setError,   setExpandedCreatePanel,   
  setFocusMode,   setGraphFocusIssueId,   setMilestoneFilterId,   setMoveToDonePending,   
  setPendingWorkspaceIssueIds,   setSearchQuery,   setSelectedIssue,   setShowBlocked,   
  setShowStaleOnly,   setStatusFilterId,   setTheme,   setWorkspaceInitial,   
  setWorkspaceInitialDiff,   setWorkspaceIssue,   setWorkspaceOpenCreate,   showBlocked,   
  showStaleOnly,   statusFilterId,   swimlaneDimension,   switchingProject,   tickerEntries,   
  toggleGroup,   trailControls,   viewMode,   visibilityColumns,   workspaceInitial,   
  workspaceInitialDiff,   workspaceIssue,   workspaceOpenCreate, }: BoardPageViewProps) {
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
