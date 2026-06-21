/**
 * Shared user-facing message for the AK-535 terminal-move guard, so the server
 * PATCH route and the CLI `issue move` command produce identical wording when they
 * block a move to a terminal status (Done/Cancelled) because the issue still has an
 * open, non-direct, unmerged workspace. The guard LOGIC is
 * workspace.repository.findOpenUnmergedWorkspace; this is just the message.
 *
 * Pure (no I/O / imports) so it is unit-testable and safe as a leaf lib module.
 */
export function openWorkspaceBlockMessage(statusName: string, branchOrId: string): string {
  return `Cannot move issue to "${statusName}": it has an open workspace (branch: ${branchOrId}) that has not been merged. Merge the workspace first (merging auto-transitions the issue to Done), or close/delete it to discard the branch.`;
}
