import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { applyReorderOptimistic } from "./reorderIssues.js";

/**
 * Optimistic in-column reorder at the board level: returns a new columns array
 * where the dragged issue carries the new sortOrder and the target column is
 * re-sorted. All other columns keep their identity.
 */
export function applyLocalReorder(
  columns: StatusWithIssues[],
  targetStatusId: string,
  issueId: string,
  sortOrder: number,
): StatusWithIssues[] {
  return columns.map((col) => {
    if (col.id !== targetStatusId) return col;
    return { ...col, issues: applyReorderOptimistic(col.issues, issueId, sortOrder) };
  });
}

/**
 * Optimistic cross-column move: removes the issue from its current column and
 * appends it to the target column with the next sortOrder and updated
 * status/timestamps. Columns that don't contain the issue keep their identity.
 */
export function moveIssueToStatus(
  columns: StatusWithIssues[],
  issue: IssueWithStatus,
  targetStatus: StatusWithIssues,
  changedAt: string,
): StatusWithIssues[] {
  let foundIssue: IssueWithStatus | undefined;
  const withoutIssue = columns.map((col) => {
    const remaining = col.issues.filter((item) => {
      if (item.id === issue.id) {
        foundIssue = item;
        return false;
      }
      return true;
    });
    return remaining.length === col.issues.length ? col : { ...col, issues: remaining };
  });
  const sourceIssue = foundIssue ?? issue;
  return withoutIssue.map((col) => {
    if (col.id !== targetStatus.id) return col;
    const nextSortOrder = col.issues.length > 0
      ? Math.max(...col.issues.map((item) => item.sortOrder)) + 100
      : 0;
    return {
      ...col,
      issues: [
        ...col.issues,
        {
          ...sourceIssue,
          statusId: targetStatus.id,
          statusName: targetStatus.name,
          sortOrder: nextSortOrder,
          updatedAt: changedAt,
          statusChangedAt: changedAt,
        },
      ],
    };
  });
}
