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
// The two surviving event-feed containers (#235): BoardFeedView bundles
// activity + digest + cross-repo, RuntimeFeedView bundles flight-recorder +
// monitor-cycles + health-events — each imports its feed components directly,
// so each feed is one lazy chunk.
export const BoardFeedView = lazy(() => import("./BoardFeedView.js").then((m) => ({ default: m.BoardFeedView })));
export const RuntimeFeedView = lazy(() => import("./RuntimeFeedView.js").then((m) => ({ default: m.RuntimeFeedView })));
export const FocusView = lazy(() => import("./FocusView.js").then((m) => ({ default: m.FocusView })));
export const StrategyTargetsView = lazy(() => import("./StrategyTargetsView.js").then((m) => ({ default: m.StrategyTargetsView })));
export const SwimlaneView = lazy(() => import("./SwimlaneView.js").then((m) => ({ default: m.SwimlaneView })));
export const FlakyTestsPanel = lazy(() => import("./FlakyTestsPanel.js").then((m) => ({ default: m.FlakyTestsPanel })));
export const RunbooksView = lazy(() => import("./RunbooksView.js").then((m) => ({ default: m.RunbooksView })));
export const SprintCapacityPlanner = lazy(() => import("./SprintCapacityPlanner.js").then((m) => ({ default: m.SprintCapacityPlanner })));
export const StaleWorkDashboard = lazy(() => import("./StaleWorkDashboard.js").then((m) => ({ default: m.StaleWorkDashboard })));
// Tabbed Analytics container (#234) — imports the seven chart components directly,
// so the whole analytics bundle is one lazy chunk.
export const AnalyticsView = lazy(() => import("./AnalyticsView.js").then((m) => ({ default: m.AnalyticsView })));
export const CalendarView = lazy(() => import("./CalendarView.js").then((m) => ({ default: m.CalendarView })));
export const DriveDashboard = lazy(() => import("./DriveDashboard.js").then((m) => ({ default: m.DriveDashboard })));
export const PluginViewsPanel = lazy(() => import("./PluginViewsPanel.js").then((m) => ({ default: m.PluginViewsPanel })));
export const PluginMarketplacePanel = lazy(() => import("./PluginMarketplacePanel.js").then((m) => ({ default: m.PluginMarketplacePanel })));
export const PluginGuidePanel = lazy(() => import("./PluginGuidePanel.js").then((m) => ({ default: m.PluginGuidePanel })));
