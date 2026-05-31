export const LEGACY_TERMINAL_STATUS_NAMES = new Set(["Done", "Cancelled"]);
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
  if (isWorkflowDrivenIssue(issue)) return issue.currentNodeType === "end";
  return issue.statusName != null && legacyTerminalStatusNames.has(issue.statusName);
}

export function isTerminalStatusIdView(
  issue: StatusViewIssue,
  legacyTerminalStatusIds: ReadonlySet<string>,
): boolean {
  if (isWorkflowDrivenIssue(issue)) return issue.currentNodeType === "end";
  return issue.statusId != null && legacyTerminalStatusIds.has(issue.statusId);
}

export function isResolvedDependencyStatusView(issue: StatusViewIssue): boolean {
  return isTerminalStatusView(issue, LEGACY_RESOLVED_DEPENDENCY_STATUS_NAMES);
}
