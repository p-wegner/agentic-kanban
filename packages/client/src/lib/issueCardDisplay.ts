/**
 * Pure display-logic for the kanban `IssueCard`: the aging-heatmap bucket and
 * the action-button visibility rules. Both were inlined in `IssueCardImpl`
 * (the card's CC hotspot) and encode real product rules — which quick actions
 * a card may show given the issue's state and which callbacks the board wired.
 * Extracted here so those rules are unit-tested rather than trapped behind a
 * React render, and shared by the action row and the context menu.
 */

export type AgingBucket = "fresh" | "warm" | "hot";

/**
 * Map a column-age (days the issue has sat in its current column) to a heatmap
 * bucket. Returns `"fresh"` whenever the heatmap is off, regardless of age.
 */
export function deriveAgingBucket(
  agingDays: number,
  opts: { showAgingHeatmap: boolean; agingWarmDays: number; agingHotDays: number },
): AgingBucket {
  if (!opts.showAgingHeatmap || agingDays < opts.agingWarmDays) return "fresh";
  if (agingDays < opts.agingHotDays) return "warm";
  return "hot";
}

export interface IssueCardActionInputs {
  /** Current column/status name — "Done"/"Cancelled" suppress the action row. */
  statusName: string;
  /** Optimistic placeholder card (mid-create); no actions until it's real. */
  isPendingIssue: boolean;
  /** Main workspace exists and is not closed. */
  hasActiveWorkspace: boolean;
  /** Main workspace has an id (required to open a diff). */
  hasMainWorkspaceId: boolean;
  /** Name of the next status, if a "move to next" target exists. */
  nextStatusName: string | null | undefined;
  /** Whether each corresponding callback was supplied by the board. */
  canResume: boolean;
  canOpenDiff: boolean;
  canStartWorkspace: boolean;
  canDryRun: boolean;
  canMoveToNext: boolean;
}

export interface IssueCardActionVisibility {
  showActionRow: boolean;
  showResume: boolean;
  showDiff: boolean;
  showStartWorkspace: boolean;
  showDryRun: boolean;
  showMoveToNext: boolean;
  hasAnyAction: boolean;
}

/**
 * Decide which quick-action affordances an issue card shows. The action row is
 * hidden for pending cards and terminal statuses (Done/Cancelled), but a diff
 * stays viewable for any non-pending issue with an active workspace (auto-merged
 * Done issues still have a viewable diff) — hence `showDiff` keys off
 * `!isPendingIssue` rather than the full action-row gate.
 */
export function deriveIssueCardActions(input: IssueCardActionInputs): IssueCardActionVisibility {
  const showActionRow =
    !input.isPendingIssue && input.statusName !== "Done" && input.statusName !== "Cancelled";
  const showResume = showActionRow && input.hasActiveWorkspace && input.canResume;
  const showDiff =
    !input.isPendingIssue && input.hasActiveWorkspace && input.canOpenDiff && input.hasMainWorkspaceId;
  const showStartWorkspace = showActionRow && !input.hasActiveWorkspace && input.canStartWorkspace;
  const showDryRun = showActionRow && !input.hasActiveWorkspace && input.canDryRun;
  const showMoveToNext = showActionRow && input.canMoveToNext && !!input.nextStatusName;
  const hasAnyAction = showResume || showDiff || showStartWorkspace || showDryRun || showMoveToNext;
  return {
    showActionRow,
    showResume,
    showDiff,
    showStartWorkspace,
    showDryRun,
    showMoveToNext,
    hasAnyAction,
  };
}
