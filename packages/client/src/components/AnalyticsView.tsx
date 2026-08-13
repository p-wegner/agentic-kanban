import { ANALYTICS_TABS, ANALYTICS_VIEW_ID, type AnalyticsTabId } from "../lib/viewTabs.js";
import { useViewTab } from "../hooks/useViewTab.js";
import { ViewTabBar } from "./ViewTabBar.js";
import { BoardErrorBoundary } from "./BoardErrorBoundary.js";
import { ThroughputChart } from "./ThroughputChart.js";
import { LeadTimeTrendChart } from "./LeadTimeTrendChart.js";
import { BurndownChart } from "./BurndownChart.js";
import { ProviderMixChart } from "./ProviderMixChart.js";
import { ProviderCostOverTimeChart } from "./ProviderCostOverTimeChart.js";
import { AgentThroughputLeaderboard } from "./AgentThroughputLeaderboard.js";
import { ScorecardDistributionChart } from "./ScorecardDistributionChart.js";

interface AnalyticsViewProps {
  projectId: string;
}

/**
 * Tabbed Analytics container (#234): absorbs the seven former single-chart
 * views — Flow (throughput, lead time, burndown) and Agents (provider mix,
 * provider cost, leaderboard, score distribution) — as tabs. Each chart
 * component is re-parented unchanged; this view only owns tab selection
 * (deep-linkable via `?tab=`, preselectable via the command palette through
 * viewTabStore). The calendar view was NOT absorbed: it is a full board layout
 * (columns + issue interaction), not a projectId-driven chart.
 */
export function AnalyticsView({ projectId }: AnalyticsViewProps) {
  const [tab, selectTab] = useViewTab<AnalyticsTabId>(ANALYTICS_VIEW_ID);
  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <ViewTabBar tabs={ANALYTICS_TABS} active={tab} onSelect={selectTab} />
      {tab === "throughput" && (
        <BoardErrorBoundary columnName="Throughput">
          <ThroughputChart projectId={projectId} />
        </BoardErrorBoundary>
      )}
      {tab === "lead-time" && (
        <BoardErrorBoundary columnName="Lead Time Trend">
          <LeadTimeTrendChart projectId={projectId} />
        </BoardErrorBoundary>
      )}
      {tab === "burndown" && (
        <BoardErrorBoundary columnName="Burndown">
          <BurndownChart projectId={projectId} />
        </BoardErrorBoundary>
      )}
      {tab === "provider-mix" && (
        <BoardErrorBoundary columnName="Provider Mix">
          <ProviderMixChart projectId={projectId} />
        </BoardErrorBoundary>
      )}
      {tab === "provider-cost" && (
        <BoardErrorBoundary columnName="Provider Cost Over Time">
          <ProviderCostOverTimeChart projectId={projectId} />
        </BoardErrorBoundary>
      )}
      {tab === "agent-throughput" && (
        <BoardErrorBoundary columnName="Agent Throughput Leaderboard">
          <AgentThroughputLeaderboard projectId={projectId} />
        </BoardErrorBoundary>
      )}
      {tab === "scorecard-distribution" && (
        <BoardErrorBoundary columnName="Score Distribution">
          <ScorecardDistributionChart projectId={projectId} />
        </BoardErrorBoundary>
      )}
    </div>
  );
}
