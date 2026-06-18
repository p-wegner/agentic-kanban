export const LEGACY_TERMINAL_STATUS_NAMES = new Set(["Done", "Cancelled", "Archived"]);
export const LEGACY_RESOLVED_DEPENDENCY_STATUS_NAMES = new Set(["Done", "AI Reviewed", "Cancelled"]);

/**
 * The terminal status-column names a status MOVE / transition treats as "closed".
 * Single source of truth for the `["Done", "Cancelled"]` literal that was copied
 * across the MCP move/update guards, the terminal-workspace reaper, and several
 * services. Excludes the legacy "Archived" (that wider set is
 * LEGACY_TERMINAL_STATUS_NAMES, used by the dependency-resolution view).
 */
export const TERMINAL_STATUS_NAMES = ["Done", "Cancelled"] as const;

/** Whether a status-column name is terminal (Done / Cancelled). */
export function isTerminalStatusName(name: string | null | undefined): boolean {
  return name === "Done" || name === "Cancelled";
}

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

/**
 * The landing signal for a single blocker's workspace: did its branch actually
 * reach the base branch? `mergedAt` is stamped ONLY after the git merge succeeds
 * and post-merge ancestry is verified; a `isDirect` workspace commits straight to
 * the branch with no merge step, so it counts as landed.
 */
export interface BlockerWorkspaceLanding {
  mergedAt?: string | null;
  isDirect?: boolean | null;
}

/**
 * The shared dependency-readiness predicate used by BOTH the monitor auto-start
 * path (`runAutoStart`) and the dependency-wave planner (`startNextDependencyWave`).
 *
 * A blocker only unblocks its dependents when BOTH hold:
 *
 *  1. Terminal status — the blocker reached a Done/Cancelled/Archived status (or an
 *     `end` workflow node). Status-only resolution (#535/#537).
 *  2. Landed on base — the blocker's work is actually ON the base branch, not merely
 *     in a terminal status. A workspace can be closed at the Done transition while the
 *     branch→base merge is still QUEUED for the async auto-merge orchestrator (it
 *     drains on a timer). So "Done" — and even "closed" — does not imply "on master"
 *     (#784): a dependent cut from the PRE-merge base (an empty scaffold) re-scaffolds
 *     the app and the blocker's merge is silently lost.
 *
 * Landed-on-base is true iff the blocker has NO workspace (resolved manually — nothing
 * to merge) OR at least one workspace that reached the branch (`mergedAt` set, or a
 * direct commit). An open review / closed-but-unmerged workspace contributes nothing,
 * so a blocker whose only work is still un-merged stays blocked until the orchestrator
 * lands it on a later cycle (the #782 fan-in case resolves once ALL its blockers land).
 *
 * Pure: callers query the blocker's terminal status and its workspaces, then pass the
 * results in. `isTerminal` lets each caller use whichever terminal predicate it already
 * computed (status-name vs status-id view) — the landing logic is identical for both.
 */
export function computeBlockerReadiness(input: {
  isTerminal: boolean;
  workspaces: ReadonlyArray<BlockerWorkspaceLanding>;
}): boolean {
  if (!input.isTerminal) return false;
  if (input.workspaces.length === 0) return true;
  return input.workspaces.some((w) => w.mergedAt != null || w.isDirect === true);
}
