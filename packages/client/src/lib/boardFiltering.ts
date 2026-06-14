import { isIssueInFlight } from "@agentic-kanban/shared";
import type { IssueWithStatus } from "@agentic-kanban/shared";

/** Active board filters applied to every issue on the board. */
export interface BoardFilterOptions {
  focusMode: boolean;
  statusFilterId: string | null;
  activeTagIds: Set<string>;
  milestoneFilterId: string | null;
  issueTypeFilter: string | null;
  priorityFilter: string | null;
  showBlocked: boolean;
  showStaleOnly: boolean;
  searchQuery: string;
}

/** Filter predicate: true when the issue matches all active board filters. */
export function matchesBoardFilters(
  issue: IssueWithStatus,
  options: BoardFilterOptions,
): boolean {
  const { focusMode, statusFilterId, activeTagIds, milestoneFilterId, issueTypeFilter, priorityFilter, showBlocked, showStaleOnly, searchQuery } = options;
  if (focusMode && !isIssueInFlight(issue.workspaceSummary)) return false;
  if (statusFilterId && issue.statusId !== statusFilterId) return false;
  if (activeTagIds.size > 0 && !issue.tags?.some((tag) => activeTagIds.has(tag.id))) return false;
  if (milestoneFilterId && issue.milestoneId !== milestoneFilterId) return false;
  if (issueTypeFilter && issue.issueType !== issueTypeFilter) return false;
  if (priorityFilter && issue.priority !== priorityFilter) return false;
  if (showBlocked && !(issue as IssueWithStatus & { isBlocked?: boolean }).isBlocked) return false;
  if (showStaleOnly && !issue.isStale) return false;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    return (
      issue.title.toLowerCase().includes(q) ||
      (issue.description?.toLowerCase().includes(q) ?? false) ||
      (issue.tags?.some((tag) => tag.name.toLowerCase().includes(q)) ?? false)
    );
  }
  return true;
}
