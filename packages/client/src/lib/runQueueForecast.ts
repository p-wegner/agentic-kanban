import type { IssueWithStatus, MainWorkspaceInfo, StatusWithIssues } from "@agentic-kanban/shared";
import { isAgentRunningStatus } from "@agentic-kanban/shared/lib/workspace-liveness";

/**
 * The run-queue forecast: how many agents are running or reviewing for a project, how many
 * slots that leaves against the WIP target, and which tickets would fill them.
 *
 * #1102 moved this pure half out of `components/RunQueueForecastPanel.tsx` so the Autopilot
 * chip's hook can share it: a hook may import lib/ but never a component (client-hooks-not-up-to-components-or-routes),
 * and the chip and the forecast must agree on ONE WIP number. The panel re-exports these, so
 * every existing importer is unchanged.
 */

export interface RunQueueForecastStart {
  issue: IssueWithStatus;
  slotLabel: string;
  sourceLabel: string;
}

export interface RunQueueForecast {
  activeTarget: number;
  runningCount: number;
  idleCount: number;
  reviewCount: number;
  pendingMergeCount: number;
  openSlots: number;
  nextStarts: RunQueueForecastStart[];
}

interface SlotCandidate {
  label: string;
  timestamp: number;
}

interface StartCandidate {
  issue: IssueWithStatus;
  rank: number;
}


const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function parseActiveTarget(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function isRunningStatus(status: MainWorkspaceInfo["status"]): boolean {
  return isAgentRunningStatus(status);
}

function isReviewStatus(status: MainWorkspaceInfo["status"]): boolean {
  return status === "reviewing";
}

function isIdleCapacityStatus(status: MainWorkspaceInfo["status"]): boolean {
  return status === "idle" || status === "awaiting-plan-approval" || status === "error";
}

function hasOpenWorkspace(issue: IssueWithStatus): boolean {
  const workspace = issue.workspaceSummary?.main;
  return Boolean(workspace && workspace.status !== "closed");
}

function isStartableIssue(issue: IssueWithStatus): boolean {
  if (issue.isBlocked) return false;
  if (hasOpenWorkspace(issue)) return false;
  return issue.statusName === "Todo" || issue.statusName === "Backlog";
}

function sortIssuesForStart(a: StartCandidate, b: StartCandidate): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const priorityDelta = (PRIORITY_RANK[a.issue.priority] ?? 99) - (PRIORITY_RANK[b.issue.priority] ?? 99);
  if (priorityDelta !== 0) return priorityDelta;
  if (a.issue.sortOrder !== b.issue.sortOrder) return a.issue.sortOrder - b.issue.sortOrder;
  const aUpdated = new Date(a.issue.updatedAt).getTime();
  const bUpdated = new Date(b.issue.updatedAt).getTime();
  return aUpdated - bUpdated;
}

function slotTimestamp(issue: IssueWithStatus, workspace: MainWorkspaceInfo): number {
  const source = workspace.lastSessionAt ?? issue.statusChangedAt ?? issue.updatedAt;
  const timestamp = source ? new Date(source).getTime() : Date.now();
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function slotLabel(issue: IssueWithStatus, workspace: MainWorkspaceInfo): string {
  const issueLabel = issue.issueNumber ? `#${issue.issueNumber}` : issue.title;
  if (workspace.readyForMerge) return `${issueLabel} merges`;
  if (workspace.status === "reviewing") return `${issueLabel} review finishes`;
  if (workspace.status === "fixing") return `${issueLabel} conflict fix finishes`;
  return `${issueLabel} agent finishes`;
}

export function buildRunQueueForecast(columns: StatusWithIssues[], activeTargetInput: string | number): RunQueueForecast {
  const activeTarget = parseActiveTarget(activeTargetInput);
  const allIssues = columns.flatMap((column) => column.issues);
  const openWorkspaces = allIssues
    .map((issue) => ({ issue, workspace: issue.workspaceSummary?.main }))
    .filter((entry): entry is { issue: IssueWithStatus; workspace: MainWorkspaceInfo } =>
      Boolean(entry.workspace && entry.workspace.status !== "closed")
    );

  const runningCount = openWorkspaces.filter(({ workspace }) => isRunningStatus(workspace.status)).length;
  const reviewCount = openWorkspaces.filter(({ workspace }) => isReviewStatus(workspace.status)).length;
  const idleCount = openWorkspaces.filter(({ workspace }) => isIdleCapacityStatus(workspace.status)).length;
  const pendingMergeCount = openWorkspaces.filter(({ issue, workspace }) =>
    issue.statusName === "In Review" || workspace.readyForMerge === true
  ).length;
  const occupiedSlots = runningCount + reviewCount;
  const openSlots = Math.max(0, activeTarget - occupiedSlots);

  const startCandidates = allIssues
    .map((issue) => ({
      issue,
      rank: issue.statusName === "Todo" ? 0 : 1,
    }))
    .filter((candidate) => isStartableIssue(candidate.issue))
    .sort(sortIssuesForStart);

  const immediateSlots: SlotCandidate[] = Array.from({ length: openSlots }, (_, index) => ({
    label: index === 0 ? "open slot now" : `open slot ${index + 1} now`,
    timestamp: 0,
  }));

  const futureSlots = openWorkspaces
    .filter(({ workspace }) => isRunningStatus(workspace.status) || isReviewStatus(workspace.status))
    .map(({ issue, workspace }) => ({
      label: slotLabel(issue, workspace),
      timestamp: slotTimestamp(issue, workspace),
    }))
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.label.localeCompare(b.label);
    });

  const slots = [...immediateSlots, ...futureSlots];
  const nextStarts = startCandidates.slice(0, 2).map((candidate, index) => {
    const slot = slots[index];
    return {
      issue: candidate.issue,
      slotLabel: slot?.label ?? "after current queue clears",
      sourceLabel: slot ? "capacity forecast" : "waiting for capacity",
    };
  });

  return {
    activeTarget,
    runningCount,
    idleCount,
    reviewCount,
    pendingMergeCount,
    openSlots,
    nextStarts,
  };
}
