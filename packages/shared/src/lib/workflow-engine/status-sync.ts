import { and, eq, asc, sql } from "drizzle-orm";
import * as schema from "../../schema/index.js";
import type { WorkflowDb } from "./types.js";

interface StatusOrderRow { id: string; name: string; sortOrder: number }

/**
 * Decide what to do with a stale `currentNodeId` when the issue's new status has
 * NO node in its workflow template.
 *
 * Returns `null` to clear the node (the move was backwards, off the graph — the
 * stale node would otherwise keep overriding the board column, #381) or
 * `undefined` to leave it untouched (forward move off the graph, e.g. into
 * `AI Reviewed`, where the workspace still needs its node to advance).
 */
export function clearedNodeIdForUnmappedStatus(
  currentNode: { statusName: string | null } | undefined,
  newStatus: StatusOrderRow,
  projectStatuses: readonly StatusOrderRow[],
): null | undefined {
  if (!currentNode?.statusName) return undefined;
  const staleStatus = projectStatuses.find((s) => s.name === currentNode.statusName);
  if (!staleStatus) return undefined;
  return newStatus.sortOrder < staleStatus.sortOrder ? null : undefined;
}

/**
 * Keep currentNodeId consistent when an issue's status is changed manually
 * (drag-drop, move_issue, CLI). If the issue runs a workflow, point currentNodeId
 * at a node in its template whose statusName matches the issue's (new) status.
 * No-op when the issue has no workflow.
 *
 * When no node maps to the new status the node used to be left alone, which is
 * the root cause of #381. A workflow template only covers a SUBSET of the
 * project's statuses (a typical bugfix template has nodes for In Progress /
 * In Review / Done but none for Backlog, Todo, AI Reviewed or Cancelled), so the
 * issue kept a node naming a DIFFERENT status than it was now in — and every
 * consumer that derives an "effective status" from `workspaces.current_node_id`
 * (`buildBoardColumns` in the board view, `selectMainWorkspace` in
 * `get_board_status`) then silently overrode the move. Observed: three issues
 * moved back to Backlog kept rendering in the In Review column indefinitely,
 * unaffected by a full server restart, because the stale node still said
 * "In Review".
 *
 * The fix clears the node — but only for a BACKWARDS move (the new status sorts
 * before the stale node's status). A forward move off the graph must keep the
 * node: `AI Reviewed` has no node in these templates either, yet a workspace
 * parked there still has to be able to advance, and advancing reads
 * `currentNodeId` to find its outgoing transitions. Clearing is recoverable
 * anyway — moving the issue to a status the template DOES cover re-points the
 * node on the next sync.
 */
export async function syncCurrentNodeToStatus(db: WorkflowDb, issueId: string): Promise<void> {
  const issueRows = await db
    .select({ workflowTemplateId: schema.issues.workflowTemplateId, statusId: schema.issues.statusId, currentNodeId: schema.issues.currentNodeId, projectId: schema.issues.projectId })
    .from(schema.issues)
    .where(eq(schema.issues.id, issueId))
    .limit(1);
  const issue = issueRows[0];
  if (!issue?.workflowTemplateId || !issue.statusId) return;

  const projectStatuses = await db
    .select({ id: schema.projectStatuses.id, name: schema.projectStatuses.name, sortOrder: schema.projectStatuses.sortOrder })
    .from(schema.projectStatuses)
    .where(eq(schema.projectStatuses.projectId, issue.projectId))
    .orderBy(asc(schema.projectStatuses.sortOrder));
  const newStatus = projectStatuses.find((s) => s.id === issue.statusId);
  const statusName = newStatus?.name;
  if (!statusName) return;

  const nodes = await db
    .select()
    .from(schema.workflowNodes)
    .where(eq(schema.workflowNodes.templateId, issue.workflowTemplateId))
    .orderBy(asc(schema.workflowNodes.sortOrder));
  // If the current node already maps to this status, leave it; else pick the first match.
  const current = nodes.find((n) => n.id === issue.currentNodeId);
  if (current && current.statusName === statusName) return;
  const match = nodes.find((n) => n.statusName === statusName);
  const nextNodeId = match ? match.id : clearedNodeIdForUnmappedStatus(current, newStatus, projectStatuses);
  if (nextNodeId === undefined) return;
  if (nextNodeId === (issue.currentNodeId ?? null)) return;
  await db.update(schema.issues).set({ currentNodeId: nextNodeId }).where(eq(schema.issues.id, issueId));
  // Also sync non-closed workspaces so the board's workflow-status override
  // reflects the new node immediately (workspaces.currentNodeId drives the
  // board column override in getBoard(); without this the board keeps showing
  // the old workflow column until the workspace-summary cache rebuilds).
  await db
    .update(schema.workspaces)
    .set({ currentNodeId: nextNodeId })
    .where(and(eq(schema.workspaces.issueId, issueId), sql`${schema.workspaces.status} != 'closed'`));
}
