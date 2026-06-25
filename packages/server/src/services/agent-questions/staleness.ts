/**
 * Per-question staleness computation — decide whether a pending question is still
 * actionable, and why not.
 */
import { isTerminalStatusView } from "@agentic-kanban/shared";
import type { Staleness, StalenessInput, StalenessReason } from "./types.js";

const STALENESS_LABELS: Record<StalenessReason, string> = {
  "workspace-merged": "stale — workspace merged",
  "issue-done": "stale — issue done",
  "superseded": "stale — superseded",
  "older-than-24h": "stale — older than 24h",
};

/**
 * Decide whether a pending question is stale, and why. Priority order matches the
 * ticket: workspace merged → issue done → superseded → older than 24h. Returns null
 * when the question is still fresh. Pure (time passed in) so it is unit-testable.
 */
export function computeStaleness(input: StalenessInput): Staleness | null {
  // 1. Workspace merged / closed.
  if (input.workspaceStatus === "closed" || (input.readyForMerge && input.workspaceClosedAt)) {
    return { reason: "workspace-merged", label: STALENESS_LABELS["workspace-merged"], at: input.workspaceClosedAt };
  }
  // 2. Issue moved to a terminal workflow node or legacy terminal status.
  if (isTerminalStatusView({
    currentNodeId: input.issueCurrentNodeId,
    currentNodeType: input.issueCurrentNodeType,
    statusName: input.issueStatusName,
  })) {
    return { reason: "issue-done", label: STALENESS_LABELS["issue-done"], at: null };
  }
  // 3. A newer session exists than the one that produced the question.
  if (
    input.questionSessionStartedAt &&
    input.latestSessionStartedAt &&
    input.latestSessionStartedAt > input.questionSessionStartedAt
  ) {
    return { reason: "superseded", label: STALENESS_LABELS["superseded"], at: input.latestSessionStartedAt };
  }
  // 4. Fallback: older than 24h.
  if (input.askedAt) {
    const ageMs = new Date(input.now).getTime() - new Date(input.askedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs > 24 * 60 * 60 * 1000) {
      return { reason: "older-than-24h", label: STALENESS_LABELS["older-than-24h"], at: input.askedAt };
    }
  }
  return null;
}
