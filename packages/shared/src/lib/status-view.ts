export const LEGACY_TERMINAL_STATUS_NAMES = new Set(["Done", "Cancelled", "Archived"]);
export const LEGACY_RESOLVED_DEPENDENCY_STATUS_NAMES = new Set(["Done", "AI Reviewed", "Cancelled"]);

export interface StatusViewIssue {
  currentNodeId?: string | null;
  currentNodeType?: string | null;
  statusId?: string | null;
  statusName?: string | null;
}

export function isWorkflowDrivenIssue(issue: StatusViewIssue): boolean {
  return issue.currentNodeId != null;
}

/**
 * Workflow issues use currentNodeId/nodeType as the source of truth. The status
 * column remains a derived/legacy view for non-workflow rows and display.
 */
export function isTerminalStatusView(
  issue: StatusViewIssue,
  legacyTerminalStatusNames: ReadonlySet<string> = LEGACY_TERMINAL_STATUS_NAMES,
): boolean {
  // A terminal STATUS (Done/Cancelled/Archived) always counts as terminal — even for a
  // workflow-driven issue whose currentNode was never advanced to an `end` node
  // (a status↔node desync). Without this, a Done-status issue stuck on a non-`end`
  // node reads as forever-open, so blocked_by/depends_on dependents never resolve and
  // the issue is treated as active by the monitor/board/wave-planner (#537).
  if (issue.statusName != null && legacyTerminalStatusNames.has(issue.statusName)) return true;
  if (isWorkflowDrivenIssue(issue)) return issue.currentNodeType === "end";
  return false;
}

export function isTerminalStatusIdView(
  issue: StatusViewIssue,
  legacyTerminalStatusIds: ReadonlySet<string>,
): boolean {
  // Mirror isTerminalStatusView (#537): a terminal STATUS id resolves the issue even
  // when workflow-driven with a non-`end` currentNode.
  if (issue.statusId != null && legacyTerminalStatusIds.has(issue.statusId)) return true;
  if (isWorkflowDrivenIssue(issue)) return issue.currentNodeType === "end";
  return false;
}

export function isResolvedDependencyStatusView(issue: StatusViewIssue): boolean {
  return isTerminalStatusView(issue, LEGACY_RESOLVED_DEPENDENCY_STATUS_NAMES);
}
