import { FOCUS_TABS, FOCUS_VIEW_ID, type FocusTabId } from "../lib/viewTabs.js";
import { useViewTab } from "../hooks/useViewTab.js";
import { ViewTabBar } from "./ViewTabBar.js";
import { BoardErrorBoundary } from "./BoardErrorBoundary.js";
import { FocusView } from "./FocusView.js";
import { SprintCapacityPlanner } from "./SprintCapacityPlanner.js";
import { StaleWorkDashboard } from "./StaleWorkDashboard.js";
import type { IssueWithStatus } from "@agentic-kanban/shared";

interface FocusHubViewProps {
  projectId: string;
  onIssueClick: (issue: IssueWithStatus) => void;
  /** Resolve a board issue by id — Focus and Stale Work hand back ids, not issues. */
  resolveIssue: (issueId: string) => IssueWithStatus | undefined;
}

/**
 * The "what should I work on next?" hub (#1067). Absorbs the former `capacity`
 * and `stale-work` views as tabs beside Focus; all three components are
 * re-parented unchanged.
 *
 * The three answered one question from different angles — what is ready (Focus),
 * how many slots are free to start it (Capacity), and what is stuck and needs a
 * nudge (Stale) — so they were three toolbar entries for one decision. Group F
 * of the view-thinning epic had already said `capacity` should be gated rather
 * than hold a permanent slot; this is the same conclusion with a home to put it in.
 *
 * Deliberately NOT extracted to a plugin: Stale Work holds WRITE authority (it
 * nudges an agent via `/turn`), which is the epic's stated line between a view
 * that can leave the board and one that cannot.
 */
export function FocusHubView({ projectId, onIssueClick, resolveIssue }: FocusHubViewProps) {
  const [tab, selectTab] = useViewTab<FocusTabId>(FOCUS_VIEW_ID);
  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <ViewTabBar tabs={FOCUS_TABS} active={tab} onSelect={selectTab} />
      {tab === "focus" && (
        <BoardErrorBoundary columnName="Focus View">
          <FocusView
            projectId={projectId}
            onIssueClick={(issueId) => {
              const issue = resolveIssue(issueId);
              if (issue) onIssueClick(issue);
            }}
          />
        </BoardErrorBoundary>
      )}
      {tab === "capacity" && (
        <BoardErrorBoundary columnName="Sprint Capacity Planner">
          <SprintCapacityPlanner projectId={projectId} />
        </BoardErrorBoundary>
      )}
      {tab === "stale" && (
        <BoardErrorBoundary columnName="Stale Work">
          <StaleWorkDashboard projectId={projectId} onIssueClick={onIssueClick} />
        </BoardErrorBoundary>
      )}
    </div>
  );
}
