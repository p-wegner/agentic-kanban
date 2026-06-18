import type { IssueWithStatus } from "@agentic-kanban/shared";
import type { LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";
import { IssueCard, type ProjectTag, type QuickUpdateCallbacks } from "./IssueCard.js";
import type { CardDensity } from "../hooks/useBoardPreferences.js";

// Presentational wrapper around IssueCard, extracted verbatim from BoardColumn's
// inline `renderCard`. Single source of truth for the IssueCard prop binding
// shared by the flat list and both swimlane modes. The aging-heatmap props are
// only forwarded when `includeAging` is set (matching the original per-branch
// prop lists), so IssueCard's defaults still apply inside swimlanes.
export interface BoardColumnCardProps {
  issue: IssueWithStatus;
  includeAging: boolean;
  onIssueClick: (issue: IssueWithStatus, event: React.MouseEvent) => void;
  onWorkspaceClick?: (issue: IssueWithStatus, workspaceId?: string) => void;
  onOpenDiff?: (issue: IssueWithStatus, workspaceId: string) => void;
  onStartWorkspace?: (issue: IssueWithStatus) => void;
  onDryRun?: (issue: IssueWithStatus) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  onDuplicate?: (issue: IssueWithStatus) => void;
  onMoveToNext?: (issue: IssueWithStatus, nextStatusId: string) => void;
  nextStatus: { id: string; name: string } | null;
  allProjectTags?: ProjectTag[];
  quickUpdate?: QuickUpdateCallbacks;
  statusOptions?: { id: string; name: string }[];
  onDeleteIssue?: (issueId: string) => void;
  searchQuery?: string;
  sessionActivity?: Record<string, string>;
  liveStats?: Record<string, LiveSessionStats>;
  sessionTodos?: Record<string, TodoItem[]>;
  pendingIssueIds?: Set<string>;
  pendingWorkspaceIssueIds?: Set<string>;
  selectedIssueIds?: Set<string>;
  keyboardCursorIssueId?: string | null;
  cardDensity?: CardDensity;
  showAgingHeatmap?: boolean;
  agingWarmDays?: number;
  agingHotDays?: number;
}

export function BoardColumnCard({
  issue,
  includeAging,
  onIssueClick,
  onWorkspaceClick,
  onOpenDiff,
  onStartWorkspace,
  onDryRun,
  onDragStart,
  onDuplicate,
  onMoveToNext,
  nextStatus,
  allProjectTags,
  quickUpdate,
  statusOptions,
  onDeleteIssue,
  searchQuery,
  sessionActivity,
  liveStats,
  sessionTodos,
  pendingIssueIds,
  pendingWorkspaceIssueIds,
  selectedIssueIds,
  keyboardCursorIssueId,
  cardDensity,
  showAgingHeatmap,
  agingWarmDays,
  agingHotDays,
}: BoardColumnCardProps) {
  return (
    <IssueCard
      issue={issue}
      onClick={onIssueClick}
      onWorkspaceClick={onWorkspaceClick}
      onOpenDiff={onOpenDiff}
      onStartWorkspace={onStartWorkspace}
      onDryRun={onDryRun}
      onDragStart={onDragStart}
      onDuplicate={onDuplicate}
      onMoveToNext={nextStatus && onMoveToNext ? (iss) => onMoveToNext(iss, nextStatus.id) : undefined}
      nextStatusName={nextStatus?.name}
      tags={issue.tags}
      allProjectTags={allProjectTags}
      quickUpdate={quickUpdate}
      allStatuses={statusOptions}
      onDeleteIssue={onDeleteIssue}
      searchQuery={searchQuery}
      liveActivity={sessionActivity?.[issue.id]}
      liveStats={liveStats?.[issue.id]}
      todos={sessionTodos?.[issue.id]}
      isPendingIssue={pendingIssueIds?.has(issue.id)}
      isPendingWorkspace={pendingWorkspaceIssueIds?.has(issue.id)}
      isSelected={selectedIssueIds?.has(issue.id)}
      isKeyboardFocused={keyboardCursorIssueId === issue.id}
      cardDensity={cardDensity}
      {...(includeAging ? { showAgingHeatmap, agingWarmDays, agingHotDays } : {})}
    />
  );
}
