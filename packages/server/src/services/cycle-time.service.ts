import { eq, asc, inArray } from "drizzle-orm";
import { issues, workspaces, workflowTransitions, workflowNodes, projectStatuses } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";

export interface StatusDuration {
  statusName: string;
  durationMs: number;
}

export interface CycleTimeResult {
  totalAgeMs: number;
  createdAt: string;
  closedAt: string | null;
  isOpen: boolean;
  statusBreakdowns: StatusDuration[];
}

export async function getIssueCycleTime(issueId: string, database: Database, nowOverride?: string): Promise<CycleTimeResult | null> {
  const now = nowOverride ?? new Date().toISOString();

  const issueRows = await database
    .select({
      id: issues.id,
      createdAt: issues.createdAt,
      statusChangedAt: issues.statusChangedAt,
      statusName: projectStatuses.name,
    })
    .from(issues)
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.id, issueId))
    .limit(1);

  if (issueRows.length === 0) return null;

  const issue = issueRows[0];
  const isDone = issue.statusName != null &&
    ["done", "cancelled"].includes(issue.statusName.toLowerCase());
  const closedAt = isDone && issue.statusChangedAt ? issue.statusChangedAt : null;
  const endTime = closedAt ?? now;

  const totalAgeMs = new Date(endTime).getTime() - new Date(issue.createdAt).getTime();

  // Collect all workflow transitions across all workspaces for this issue, ordered by time
  const wsRows = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.issueId, issueId));

  if (wsRows.length === 0) {
    return {
      totalAgeMs,
      createdAt: issue.createdAt,
      closedAt,
      isOpen: !isDone,
      statusBreakdowns: [],
    };
  }

  const workspaceIds = wsRows.map((w) => w.id);

  // Fetch transitions for all workspaces in a single query
  const allTransitions = await database
    .select({
      workspaceId: workflowTransitions.workspaceId,
      toNodeId: workflowTransitions.toNodeId,
      createdAt: workflowTransitions.createdAt,
    })
    .from(workflowTransitions)
    .where(inArray(workflowTransitions.workspaceId, workspaceIds))
    .orderBy(asc(workflowTransitions.createdAt));

  if (allTransitions.length === 0) {
    return {
      totalAgeMs,
      createdAt: issue.createdAt,
      closedAt,
      isOpen: !isDone,
      statusBreakdowns: [],
    };
  }

  // Resolve node IDs to status names in a single query
  const nodeIds = [...new Set(allTransitions.map((t) => t.toNodeId))];
  const nodeStatusMap = new Map<string, string>();
  if (nodeIds.length > 0) {
    const nodeRows = await database
      .select({ id: workflowNodes.id, statusName: workflowNodes.statusName })
      .from(workflowNodes)
      .where(inArray(workflowNodes.id, nodeIds));
    for (const row of nodeRows) {
      if (row.statusName) nodeStatusMap.set(row.id, row.statusName);
    }
  }

  // Aggregate per-status durations: for each transition, the time spent in that
  // status runs from the transition's createdAt until the next transition (or now).
  // Multiple workspaces may overlap in time; we accumulate durations per status name.
  const durationByStatus = new Map<string, number>();

  // Sort all transitions globally by time
  allTransitions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (let i = 0; i < allTransitions.length; i++) {
    const t = allTransitions[i];
    const statusName = nodeStatusMap.get(t.toNodeId);
    if (!statusName) continue;

    // Find the next transition for the same workspace to know when this status ended
    let exitTime: string = endTime;
    for (let j = i + 1; j < allTransitions.length; j++) {
      if (allTransitions[j].workspaceId === t.workspaceId) {
        exitTime = allTransitions[j].createdAt;
        break;
      }
    }

    const enteredMs = new Date(t.createdAt).getTime();
    const exitedMs = new Date(exitTime).getTime();
    const spanMs = Math.max(0, exitedMs - enteredMs);

    durationByStatus.set(statusName, (durationByStatus.get(statusName) ?? 0) + spanMs);
  }

  const statusBreakdowns: StatusDuration[] = Array.from(durationByStatus.entries())
    .map(([statusName, durationMs]) => ({ statusName, durationMs }))
    .sort((a, b) => b.durationMs - a.durationMs);

  return {
    totalAgeMs,
    createdAt: issue.createdAt,
    closedAt,
    isOpen: !isDone,
    statusBreakdowns,
  };
}
