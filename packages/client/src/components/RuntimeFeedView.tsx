import { RUNTIME_TABS, RUNTIME_TAB_IDS, RUNTIME_VIEW_ID, type RuntimeTabId } from "../lib/viewTabs.js";
import type { FlightRecorderTranscriptTarget } from "../lib/flightRecorderEvents.js";
import { useViewTab } from "../hooks/useViewTab.js";
import { ViewTabBar } from "./ViewTabBar.js";
import { BoardErrorBoundary } from "./BoardErrorBoundary.js";
import { AgentFlightRecorder } from "./AgentFlightRecorder.js";
import { MonitorCycleHistoryPanel } from "./MonitorCycleHistoryPanel.js";
import { BoardHealthNotificationCenter } from "./BoardHealthNotificationCenter.js";

interface RuntimeFeedViewProps {
  projectId: string;
  /** Resolve an issue's number/title for flight-recorder entry labels (built from the board columns). */
  resolveIssue: (issueId: string) => { issueNumber: number | null; title?: string | null } | undefined;
  /** Open the workspace transcript for a flight-recorder event. */
  onJumpToTranscript: (target: FlightRecorderTranscriptTarget) => void;
  /** Open an issue referenced by a health event. */
  onOpenIssue: (issueNumber: number) => void;
}

/**
 * The operational event feed (#235): what the MACHINERY is doing. Absorbs the
 * former `agent-flight-recorder`, `monitor-history`, and `health-events` views
 * as tabs; the panels are re-parented unchanged. Monitor Cycles and Health
 * Events read the same endpoint (/api/projects/:id/board-health-events) and
 * were the most redundant pair of the six feeds — here they sit side by side.
 */
export function RuntimeFeedView({ projectId, resolveIssue, onJumpToTranscript, onOpenIssue }: RuntimeFeedViewProps) {
  const [tab, selectTab] = useViewTab<RuntimeTabId>(RUNTIME_VIEW_ID, RUNTIME_TAB_IDS, "flight-recorder");
  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <ViewTabBar tabs={RUNTIME_TABS} active={tab} onSelect={selectTab} />
      {tab === "flight-recorder" && (
        <BoardErrorBoundary columnName="Agent Flight Recorder">
          <AgentFlightRecorder
            projectId={projectId}
            resolveIssue={resolveIssue}
            onJumpToTranscript={onJumpToTranscript}
          />
        </BoardErrorBoundary>
      )}
      {tab === "monitor-cycles" && (
        <BoardErrorBoundary columnName="Monitor History">
          <MonitorCycleHistoryPanel projectId={projectId} />
        </BoardErrorBoundary>
      )}
      {tab === "health-events" && (
        <BoardErrorBoundary columnName="Board Health Events">
          <BoardHealthNotificationCenter projectId={projectId} onOpenIssue={onOpenIssue} />
        </BoardErrorBoundary>
      )}
    </div>
  );
}
