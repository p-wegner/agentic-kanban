// #973 — a workspace launch that finishes must not steal the UI.
//
// Starting a workspace is an async round trip (POST /api/workspaces plus a board
// refetch); on a cold worktree that is seconds, not milliseconds. Both launch
// paths — the drag-to-agent-slot quick start and create-issue-with-workspace —
// used to call `setWorkspaceIssue(...)` unconditionally when the POST resolved,
// so a user who had moved on in the meantime (clicked another card, opened
// another panel, pressed Escape) had the workspace drawer thrown over whatever
// they were doing. The panel is *wanted* when the launch is still the user's
// current context; it is an interruption once it is not.
//
// The rule is therefore "auto-open only if the selection has not moved since the
// launch began". This module is the pure half of that decision so it can be
// unit-tested without React; the callers snapshot the selection before awaiting
// and consult `shouldAutoOpenWorkspacePanel` after.

/**
 * The parts of the board selection that decide whether an auto-open would be a
 * continuation of the user's action or an interruption of a newer one.
 */
export interface WorkspaceAutoOpenSelection {
  /** Issue id shown in the detail panel, or null when it is closed. */
  selectedIssueId: string | null;
  /** Issue id whose workspace drawer is open, or null when it is closed. */
  workspaceIssueId: string | null;
}

export interface WorkspaceAutoOpenInput {
  /** Selection captured immediately BEFORE the launch request was issued. */
  before: WorkspaceAutoOpenSelection;
  /** Selection as it stands now that the launch has resolved. */
  after: WorkspaceAutoOpenSelection;
  /** The issue the launch was for. */
  launchedIssueId: string;
}

/**
 * True when the finished launch may open the workspace panel.
 *
 * Allowed:
 *  - the selection is unchanged (the user is still where they were), or
 *  - the user already has this very issue open in either panel — the drawer is
 *    then a refinement of their own current context, not a hijack.
 *
 * Refused whenever the user moved to a DIFFERENT issue, or deliberately closed
 * what they had open, while the launch was in flight. Closing counts as moving
 * on: a user who pressed Escape asked for no panel, and answering that with a
 * drawer seconds later is the same interruption.
 */
export function shouldAutoOpenWorkspacePanel(input: WorkspaceAutoOpenInput): boolean {
  const { before, after, launchedIssueId } = input;
  if (
    after.selectedIssueId === before.selectedIssueId &&
    after.workspaceIssueId === before.workspaceIssueId
  ) {
    return true;
  }
  return after.selectedIssueId === launchedIssueId || after.workspaceIssueId === launchedIssueId;
}
