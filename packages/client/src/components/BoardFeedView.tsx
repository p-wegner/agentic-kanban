import { ACTIVITY_TABS, ACTIVITY_VIEW_ID, type ActivityTabId } from "../lib/viewTabs.js";
import { useViewTab } from "../hooks/useViewTab.js";
import { useProjectRepos } from "../hooks/useProjectRepos.js";
import { ViewTabBar } from "./ViewTabBar.js";
import { BoardErrorBoundary } from "./BoardErrorBoundary.js";
import { ActivityFeedView } from "./ActivityFeedView.js";
import { DigestView } from "./DigestView.js";
import { CrossRepoActivityFeed } from "./CrossRepoActivityFeed.js";

interface BoardFeedViewProps {
  projectId: string;
  /** Resolve an issue's number for cross-repo entry links/labels (built from the board columns). */
  resolveIssue: (issueId: string) => { issueNumber: number | null } | undefined;
  onIssueClick: (issueId: string) => void;
}

/**
 * The board-side event feed (#235): what happened to the BOARD. Absorbs the
 * former `digest` and `cross-repo-activity` views as tabs beside the activity
 * feed; the feed components are re-parented unchanged. The Cross-Repo tab is
 * offered only on multi-repo projects (useProjectRepos.isMultiRepo) — on a
 * single-repo project it showed nothing at all.
 */
export function BoardFeedView({ projectId, resolveIssue, onIssueClick }: BoardFeedViewProps) {
  const { isMultiRepo } = useProjectRepos(projectId);
  const [tab, selectTab] = useViewTab<ActivityTabId>(ACTIVITY_VIEW_ID);
  const tabs = isMultiRepo ? ACTIVITY_TABS : ACTIVITY_TABS.filter((t) => t.id !== "cross-repo");
  // A stale cross-repo selection (deep link, project switch) on a single-repo
  // project falls back to the activity tab instead of a blank feed.
  const effectiveTab: ActivityTabId = tab === "cross-repo" && !isMultiRepo ? "activity" : tab;
  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <ViewTabBar tabs={tabs} active={effectiveTab} onSelect={selectTab} />
      {effectiveTab === "activity" && (
        <BoardErrorBoundary columnName="Activity Feed">
          <ActivityFeedView projectId={projectId} onIssueClick={onIssueClick} />
        </BoardErrorBoundary>
      )}
      {effectiveTab === "digest" && (
        <BoardErrorBoundary columnName="Digest View">
          <DigestView projectId={projectId} onIssueClick={onIssueClick} />
        </BoardErrorBoundary>
      )}
      {effectiveTab === "cross-repo" && (
        <BoardErrorBoundary columnName="Cross-Repo Activity">
          <CrossRepoActivityFeed
            projectId={projectId}
            resolveIssue={resolveIssue}
            onIssueClick={onIssueClick}
          />
        </BoardErrorBoundary>
      )}
    </div>
  );
}
