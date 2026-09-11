import { RUNNERS_TABS, RUNNERS_VIEW_ID, type RunnersTabId } from "../lib/viewTabs.js";
import { useViewTab } from "../hooks/useViewTab.js";
import { ViewTabBar } from "./ViewTabBar.js";
import { BoardErrorBoundary } from "./BoardErrorBoundary.js";
import { RunnersFleetPanel } from "./RunnersFleetPanel.js";
import { WorkerDispatchLogPanel } from "./WorkerDispatchLogPanel.js";
import { WorkerGitTransportPanel } from "./WorkerGitTransportPanel.js";
import { WorkerConnectPanel } from "./WorkerConnectPanel.js";

interface RunnersViewProps {
  /** null when no project is active — the fleet itself is not project-scoped. */
  projectId: string | null;
}

/**
 * Runners (#1089, follow-up to #1087): connected compute workers, as a tabbed view instead
 * of the former `WorkerFleetPanel` overlay. Runners / Dispatch Log / Git Transport / Connect.
 */
export function RunnersView({ projectId }: RunnersViewProps) {
  const [tab, selectTab] = useViewTab<RunnersTabId>(RUNNERS_VIEW_ID);
  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <ViewTabBar tabs={RUNNERS_TABS} active={tab} onSelect={selectTab} />
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {tab === "runners" && (
          <BoardErrorBoundary columnName="Runners">
            <RunnersFleetPanel projectId={projectId} />
          </BoardErrorBoundary>
        )}
        {tab === "dispatch-log" && (
          <BoardErrorBoundary columnName="Dispatch Log">
            <WorkerDispatchLogPanel projectId={projectId} />
          </BoardErrorBoundary>
        )}
        {tab === "git-transport" && (
          <BoardErrorBoundary columnName="Git Transport">
            <WorkerGitTransportPanel projectId={projectId} />
          </BoardErrorBoundary>
        )}
        {tab === "connect" && (
          <BoardErrorBoundary columnName="Connect">
            <WorkerConnectPanel />
          </BoardErrorBoundary>
        )}
      </div>
    </div>
  );
}
