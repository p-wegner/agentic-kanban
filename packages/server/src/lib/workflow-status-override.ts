/**
 * Decide whether a workspace's workflow node may override the column an issue is
 * shown in (`buildBoardColumns` in the board view, `selectMainWorkspace` in
 * `get_board_status`).
 *
 * The override exists so a workspace whose workflow ADVANCED ahead of the issue row
 * (a transient lag) still renders where the work actually is. It must never move a
 * ticket BACKWARDS past the status the issue itself holds: a workflow template only
 * covers a subset of the project's statuses, so a manual drag to a status with no
 * node (In Progress -> In Review on an "Analyze -> Done" template) leaves the node
 * parked on its old stage, and the stale node then snapped the card straight back to
 * the column the user had just dragged it out of. The PATCH succeeded, the DB said In
 * Review, and the board disagreed. (#381 clears the node on a backwards move for the
 * same reason; a FORWARD move keeps it so the workspace can still advance, which is
 * exactly the case this guard has to cover on the read side.)
 *
 * Rule: the node wins only when its status sorts strictly AFTER the issue's status.
 * A node status the project does not know never overrides; an issue status the
 * project does not know keeps the legacy behaviour (node wins).
 */
export function workflowNodeMayOverrideStatus(
  issueStatusName: string | null | undefined,
  nodeStatusName: string,
  /** Project statuses in column order (ascending sortOrder). */
  orderedStatusNames: readonly string[],
): boolean {
  const rank = (name: string | null | undefined): number =>
    name == null ? -1 : orderedStatusNames.findIndex((s) => s.toLowerCase() === name.toLowerCase());
  const nodeRank = rank(nodeStatusName);
  if (nodeRank < 0) return false;
  const issueRank = rank(issueStatusName);
  if (issueRank < 0) return true;
  return nodeRank > issueRank;
}
