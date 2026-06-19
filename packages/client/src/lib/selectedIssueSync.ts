import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";

/**
 * Result of reconciling the open detail panel's `selectedIssue` against a fresh
 * board payload. `changed: false` means leave the current selection untouched;
 * `changed: true` carries the value to set (a refreshed issue, or `null` when the
 * issue has disappeared from the board and the panel should close).
 */
export type SelectedIssueSync =
  | { changed: false }
  | { changed: true; next: IssueWithStatus | null };

/**
 * Keep an open panel's `selectedIssue` in sync with the latest board columns
 * (the "F6 stale data" fix). The selected issue is a snapshot captured on click;
 * background board refreshes (poll / `board_changed`) must update it in place when
 * the underlying data changes, and close the panel when the issue is gone.
 *
 * Subtlety this guards: the board payload strips `description` (the panel
 * lazy-loads it). A refresh must NOT treat the stripped (`undefined`) description
 * as a change, nor clobber the already-loaded one — otherwise the open panel's
 * body vanishes on the next refresh tick. Pure so it can be unit-tested against
 * these edge cases without a React render.
 */
export function reconcileSelectedIssue(
  columns: StatusWithIssues[],
  selectedIssue: IssueWithStatus,
): SelectedIssueSync {
  for (const col of columns) {
    const found = col.issues.find((i) => i.id === selectedIssue.id);
    if (!found) continue;

    const boardDescDiffers = found.description !== undefined && found.description !== selectedIssue.description;
    const differs =
      found.title !== selectedIssue.title ||
      boardDescDiffers ||
      found.issueType !== selectedIssue.issueType ||
      found.statusId !== selectedIssue.statusId ||
      found.statusName !== selectedIssue.statusName ||
      found.updatedAt !== selectedIssue.updatedAt ||
      found.workspaceSummary?.main?.contextTokens !== selectedIssue.workspaceSummary?.main?.contextTokens ||
      found.workspaceSummary?.main?.lastTool !== selectedIssue.workspaceSummary?.main?.lastTool ||
      found.workspaceSummary?.main?.status !== selectedIssue.workspaceSummary?.main?.status;

    if (!differs) return { changed: false };

    // Preserve a locally-loaded description when the board payload omits it.
    const next =
      found.description === undefined && selectedIssue.description !== undefined
        ? { ...found, description: selectedIssue.description }
        : found;
    return { changed: true, next };
  }

  // Issue no longer on the board — signal the panel to close.
  return { changed: true, next: null };
}
