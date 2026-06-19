// Pure helpers lifted out of BoardPage: a stable issue-card signature (used to
// skip re-renders when a board refresh returns identical card data) and an
// idle-deferral scheduler. Extracted so they're independently unit-testable.

import type { IssueWithStatus } from "@agentic-kanban/shared";

/**
 * Serialize the card-relevant fields of an issue into a stable signature string.
 * Used as a cheap equality check so an unchanged issue doesn't trigger a card
 * re-render after a board refresh.
 */
export function stringifyForIssueCard(issue: IssueWithStatus): string {
  const normalized = {
    id: issue.id,
    issueNumber: issue.issueNumber,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    issueType: issue.issueType,
    sortOrder: issue.sortOrder,
    statusId: issue.statusId,
    statusName: issue.statusName,
    projectId: issue.projectId,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    statusChangedAt: issue.statusChangedAt,
    workspaceSummary: issue.workspaceSummary,
    isBlocked: issue.isBlocked,
    isStale: issue.isStale,
    staleDays: issue.staleDays,
    columnAgeDays: issue.columnAgeDays,
    isColumnStale: issue.isColumnStale,
    skipAutoReview: issue.skipAutoReview,
    estimate: issue.estimate,
    dueDate: issue.dueDate,
    externalKey: issue.externalKey,
    externalUrl: issue.externalUrl,
    tags: issue.tags,
    checklist: issue.checklist,
    pinned: issue.pinned,
    milestoneId: issue.milestoneId,
    readyForMerge: (issue as IssueWithStatus & { readyForMerge?: boolean }).readyForMerge,
  };
  return JSON.stringify(normalized);
}

/**
 * Run `cb` when the browser is idle (requestIdleCallback), falling back to a
 * short timeout. Returns a canceller.
 */
export function deferUntilIdle(cb: () => void): () => void {
  const w = window as unknown as {
    requestIdleCallback?: (cb: () => void) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (w.requestIdleCallback) {
    const handle = w.requestIdleCallback(cb);
    return () => w.cancelIdleCallback?.(handle);
  }
  const t = setTimeout(cb, 300);
  return () => clearTimeout(t);
}
