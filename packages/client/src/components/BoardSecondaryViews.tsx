import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import type { LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";
import { BoardErrorBoundary } from "./BoardErrorBoundary.js";
import {
  GraphView, TableView, AgentGrid, TimelineView, MetricsView, CrimeSceneCityView,
  QualityMetricsView, MilestonesOverview, ButlerView, WorkflowsView,
  WorkflowAnalyticsDashboard, InsightsPanel, DigestView, ActivityFeedView, FocusView,
  StrategyTargetsView, SwimlaneView, FlakyTestsPanel, MonitorCycleHistoryPanel,
  BoardHealthNotificationCenter, RunbooksView, SprintCapacityPlanner, ConstellationView,
  MomentumView, FireworksView, StaleWorkDashboard, ThroughputChart, ProviderMixChart,
  LeadTimeTrendChart, ScorecardDistributionChart, ProviderCostOverTimeChart, CalendarView,
  AgentThroughputLeaderboard, BurndownChart, DriveDashboard,
} from "./boardLazyViews.js";

interface BoardSecondaryViewsProps {
  viewMode: string;
  activeProjectId: string | null;
  columns: StatusWithIssues[];
  searchQuery: string;
  liveActivity: Record<string, string>;
  liveStats: Record<string, LiveSessionStats>;
  sessionTodos: Record<string, TodoItem[]>;
  graphFocusIssueId?: string;
  createdDateFilter: string | null;
  activeAgentsTarget?: number;
  canStartWorkspace: boolean;
  butlerInitialPrompt: string | null;
  onIssueClick: (issue: IssueWithStatus) => void;
  onManageWorkspaces: (issue: IssueWithStatus, workspaceId?: string, sessionId?: string) => void;
  onViewModeChange: (mode: string) => void;
  onMilestoneClick: (milestoneId: string) => void;
  onOpenWorkspaceById: (id: string) => void;
  onCreatedDateClick: (date: string) => void;
  onClearCreatedDateFilter: () => void;
  onDropIssue?: (e: React.DragEvent, statusId: string) => void;
  onRefresh: () => void;
  onButlerPromptConsumed: () => void;
  setSelectedIssue: (issue: IssueWithStatus | null) => void;
  setWorkspaceIssue: (issue: IssueWithStatus | null) => void;
  setWorkspaceOpenCreate: (open: boolean) => void;
  setWorkspaceInitial: (init: { workspaceId: string; sessionId: string } | null) => void;
}

/**
 * Renders the non-kanban "secondary" board views (graph, table, agents, the
 * analytics charts, butler, drive, …) behind their `viewMode` guards. Extracted
 * verbatim from BoardPage's render to slim the route file; each view stays
 * code-split via the boardLazyViews barrel + a BoardErrorBoundary.
 */
export function BoardSecondaryViews({
  viewMode,
  activeProjectId,
  columns,
  searchQuery,
  liveActivity,
  liveStats,
  sessionTodos,
  graphFocusIssueId,
  createdDateFilter,
  activeAgentsTarget,
  canStartWorkspace,
  butlerInitialPrompt,
  onIssueClick,
  onManageWorkspaces,
  onViewModeChange,
  onMilestoneClick,
  onOpenWorkspaceById,
  onCreatedDateClick,
  onClearCreatedDateFilter,
  onDropIssue,
  onRefresh,
  onButlerPromptConsumed,
  setSelectedIssue,
  setWorkspaceIssue,
  setWorkspaceOpenCreate,
  setWorkspaceInitial,
}: BoardSecondaryViewsProps) {
  return (
    <>
      {viewMode === "graph" && activeProjectId ? (
        <div className="flex-1 min-h-0">
          <BoardErrorBoundary columnName="Graph View">
            <GraphView
              columns={columns}
              projectId={activeProjectId}
              onIssueClick={onIssueClick}
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
            onIssueClick={onIssueClick}
            searchQuery={searchQuery}
            onRefresh={onRefresh}
            createdDateFilter={createdDateFilter}
            onClearCreatedDateFilter={onClearCreatedDateFilter}
          />
        </BoardErrorBoundary>
      )}
      {viewMode === "agents" && (
        <BoardErrorBoundary columnName="Agents View">
          <AgentGrid
            columns={columns}
            liveActivity={liveActivity}
            liveStats={liveStats}
            sessionTodos={sessionTodos}
            onIssueClick={onIssueClick}
            onWorkspaceClick={onManageWorkspaces}
            onGoToBoard={() => onViewModeChange("kanban")}
            activeAgentsTarget={activeAgentsTarget}
            onDropIssue={canStartWorkspace ? onDropIssue : undefined}
          />
        </BoardErrorBoundary>
      )}
      {viewMode === "timeline" && (
        <BoardErrorBoundary columnName="Timeline View">
          <TimelineView
            columns={columns}
            onIssueClick={onIssueClick}
            searchQuery={searchQuery}
          />
        </BoardErrorBoundary>
      )}
      {viewMode === "metrics" && (
        <BoardErrorBoundary columnName="Metrics View">
          <MetricsView
            columns={columns}
            projectId={activeProjectId}
            onIssueClick={onIssueClick}
            onCreatedDateClick={onCreatedDateClick}
          />
        </BoardErrorBoundary>
      )}
      {viewMode === "crime-scene" && activeProjectId && (
        <BoardErrorBoundary columnName="Code Crime Scene">
          <CrimeSceneCityView projectId={activeProjectId} />
        </BoardErrorBoundary>
      )}
      {viewMode === "quality-metrics" && activeProjectId && (
        <BoardErrorBoundary columnName="Quality Metrics View">
          <QualityMetricsView projectId={activeProjectId} />
        </BoardErrorBoundary>
      )}
      {viewMode === "milestones" && activeProjectId && (
        <BoardErrorBoundary columnName="Milestones View">
          <MilestonesOverview
            projectId={activeProjectId}
            onMilestoneClick={onMilestoneClick}
          />
        </BoardErrorBoundary>
      )}
      {viewMode === "butler" && activeProjectId && (
        <BoardErrorBoundary columnName="Butler View">
          <ButlerView
            projectId={activeProjectId}
            columns={columns}
            liveActivity={liveActivity}
            liveStats={liveStats}
            onIssueClick={onIssueClick}
            onExit={() => onViewModeChange("kanban")}
            initialPrompt={butlerInitialPrompt ?? undefined}
            onInitialPromptConsumed={onButlerPromptConsumed}
          />
        </BoardErrorBoundary>
      )}
      {viewMode === "workflows" && activeProjectId && (
        <BoardErrorBoundary columnName="Workflows View">
          <WorkflowsView projectId={activeProjectId} onOpenWorkspace={onOpenWorkspaceById} />
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
              if (issue) onIssueClick(issue);
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
              if (issue) onIssueClick(issue);
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
              if (issue) onIssueClick(issue);
            }}
          />
        </BoardErrorBoundary>
      )}
      {viewMode === "stale-work" && activeProjectId && (
        <BoardErrorBoundary columnName="Stale Work">
          <StaleWorkDashboard
            projectId={activeProjectId}
            onIssueClick={onIssueClick}
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
            onIssueClick={onIssueClick}
            searchQuery={searchQuery}
          />
        </BoardErrorBoundary>
      )}
      {viewMode === "strategy" && activeProjectId && (
        <BoardErrorBoundary columnName="Strategic Targets">
          <StrategyTargetsView
            columns={columns}
            projectId={activeProjectId}
            onIssueClick={onIssueClick}
            searchQuery={searchQuery}
          />
        </BoardErrorBoundary>
      )}
      {viewMode === "swimlane" && (
        <BoardErrorBoundary columnName="Swimlane View">
          <SwimlaneView
            columns={columns}
            onIssueClick={onIssueClick}
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
                onViewModeChange("kanban");
                onIssueClick(issue);
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
                onViewModeChange("kanban");
                onIssueClick(issue);
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
            onIssueClick={onIssueClick}
            searchQuery={searchQuery}
          />
        </BoardErrorBoundary>
      )}
      {viewMode === "momentum" && (
        <BoardErrorBoundary columnName="Momentum View">
          <MomentumView
            columns={columns}
            onIssueClick={onIssueClick}
            searchQuery={searchQuery}
          />
        </BoardErrorBoundary>
      )}
      {viewMode === "fireworks" && (
        <BoardErrorBoundary columnName="Fireworks View">
          <FireworksView
            columns={columns}
            onIssueClick={onIssueClick}
            searchQuery={searchQuery}
          />
        </BoardErrorBoundary>
      )}
    </>
  );
}
