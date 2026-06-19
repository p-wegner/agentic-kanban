import { lazy } from "react";

// Code-split board views: every non-kanban view is rendered only behind a
// `viewMode` guard in BoardPage, so it loads on demand. Extracted from BoardPage
// to keep that file focused on board logic. The explicit `.then(m => ({ default:
// m.X }))` form preserves each component's prop types through React.lazy. Lives
// in components/ (not lib/) because a lazy import() of a component is a
// value-level edge that the client-lib-is-leaf arch rule forbids from lib.
export const GraphView = lazy(() => import("./GraphView.js").then((m) => ({ default: m.GraphView })));
export const TableView = lazy(() => import("./TableView.js").then((m) => ({ default: m.TableView })));
export const AgentGrid = lazy(() => import("./AgentGrid.js").then((m) => ({ default: m.AgentGrid })));
export const TimelineView = lazy(() => import("./TimelineView.js").then((m) => ({ default: m.TimelineView })));
export const MetricsView = lazy(() => import("./MetricsView.js").then((m) => ({ default: m.MetricsView })));
export const CrimeSceneCityView = lazy(() => import("./CrimeSceneCityView.js").then((m) => ({ default: m.CrimeSceneCityView })));
export const QualityMetricsView = lazy(() => import("./QualityMetricsView.js").then((m) => ({ default: m.QualityMetricsView })));
export const MilestonesOverview = lazy(() => import("./MilestonesOverview.js").then((m) => ({ default: m.MilestonesOverview })));
export const ButlerView = lazy(() => import("./ButlerView.js").then((m) => ({ default: m.ButlerView })));
export const WorkflowsView = lazy(() => import("./WorkflowsView.js").then((m) => ({ default: m.WorkflowsView })));
export const WorkflowAnalyticsDashboard = lazy(() => import("./WorkflowAnalyticsDashboard.js").then((m) => ({ default: m.WorkflowAnalyticsDashboard })));
export const InsightsPanel = lazy(() => import("./InsightsPanel.js").then((m) => ({ default: m.InsightsPanel })));
export const DigestView = lazy(() => import("./DigestView.js").then((m) => ({ default: m.DigestView })));
export const ActivityFeedView = lazy(() => import("./ActivityFeedView.js").then((m) => ({ default: m.ActivityFeedView })));
export const FocusView = lazy(() => import("./FocusView.js").then((m) => ({ default: m.FocusView })));
export const StrategyTargetsView = lazy(() => import("./StrategyTargetsView.js").then((m) => ({ default: m.StrategyTargetsView })));
export const SwimlaneView = lazy(() => import("./SwimlaneView.js").then((m) => ({ default: m.SwimlaneView })));
export const FlakyTestsPanel = lazy(() => import("./FlakyTestsPanel.js").then((m) => ({ default: m.FlakyTestsPanel })));
export const MonitorCycleHistoryPanel = lazy(() => import("./MonitorCycleHistoryPanel.js").then((m) => ({ default: m.MonitorCycleHistoryPanel })));
export const BoardHealthNotificationCenter = lazy(() => import("./BoardHealthNotificationCenter.js").then((m) => ({ default: m.BoardHealthNotificationCenter })));
export const RunbooksView = lazy(() => import("./RunbooksView.js").then((m) => ({ default: m.RunbooksView })));
export const SprintCapacityPlanner = lazy(() => import("./SprintCapacityPlanner.js").then((m) => ({ default: m.SprintCapacityPlanner })));
export const ConstellationView = lazy(() => import("./ConstellationView.js").then((m) => ({ default: m.ConstellationView })));
export const MomentumView = lazy(() => import("./MomentumView.js").then((m) => ({ default: m.MomentumView })));
export const FireworksView = lazy(() => import("./FireworksView.js").then((m) => ({ default: m.FireworksView })));
export const StaleWorkDashboard = lazy(() => import("./StaleWorkDashboard.js").then((m) => ({ default: m.StaleWorkDashboard })));
export const ThroughputChart = lazy(() => import("./ThroughputChart.js").then((m) => ({ default: m.ThroughputChart })));
export const ProviderMixChart = lazy(() => import("./ProviderMixChart.js").then((m) => ({ default: m.ProviderMixChart })));
export const LeadTimeTrendChart = lazy(() => import("./LeadTimeTrendChart.js").then((m) => ({ default: m.LeadTimeTrendChart })));
export const ScorecardDistributionChart = lazy(() => import("./ScorecardDistributionChart.js").then((m) => ({ default: m.ScorecardDistributionChart })));
export const ProviderCostOverTimeChart = lazy(() => import("./ProviderCostOverTimeChart.js").then((m) => ({ default: m.ProviderCostOverTimeChart })));
export const CalendarView = lazy(() => import("./CalendarView.js").then((m) => ({ default: m.CalendarView })));
export const AgentThroughputLeaderboard = lazy(() => import("./AgentThroughputLeaderboard.js").then((m) => ({ default: m.AgentThroughputLeaderboard })));
export const BurndownChart = lazy(() => import("./BurndownChart.js").then((m) => ({ default: m.BurndownChart })));
export const DriveDashboard = lazy(() => import("./DriveDashboard.js").then((m) => ({ default: m.DriveDashboard })));
