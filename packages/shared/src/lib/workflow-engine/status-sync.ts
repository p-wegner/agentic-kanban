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
 * Find the nearest node reachable from `fromNodeId` (via workflow edges, any
 * direction, BFS by hop count) whose statusName matches `statusName`. Multiple
 * nodes can share a statusName (e.g. two branches of a fork/join both landing
 * on "In Review"), so picking an arbitrary match can silently jump the
 * workspace across unrelated parts of the graph (#999). Returns null when no
 * reachable node matches — callers should then leave currentNodeId untouched
 * rather than guess.
 */
async function findNearestMatchingNode(
  db: WorkflowDb,
  templateId: string,
  nodes: { id: string; statusName: string | null }[],
  fromNodeId: string,
  statusName: string,
): Promise<string | null> {
  const edges = await db
    .select({ fromNodeId: schema.workflowEdges.fromNodeId, toNodeId: schema.workflowEdges.toNodeId })
    .from(schema.workflowEdges)
    .where(eq(schema.workflowEdges.templateId, templateId));
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (!adjacency.has(e.fromNodeId)) adjacency.set(e.fromNodeId, []);
    adjacency.get(e.fromNodeId)!.push(e.toNodeId);
    if (!adjacency.has(e.toNodeId)) adjacency.set(e.toNodeId, []);
    adjacency.get(e.toNodeId)!.push(e.fromNodeId);
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>([fromNodeId]);
  let frontier = [fromNodeId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighborId of adjacency.get(id) ?? []) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        if (nodeById.get(neighborId)?.statusName === statusName) return neighborId;
        next.push(neighborId);
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * Keep currentNodeId consistent when an issue's status is changed manually
 * (drag-drop, move_issue, CLI). If the issue runs a workflow, point currentNodeId
 * at a node in its template whose statusName matches the issue's (new) status.
 * No-op when the issue has no workflow.
 *
 * TWO ORTHOGONAL FIXES LIVE HERE, and both must hold:
 *
 * #999 decides WHICH matching node is picked. Several nodes can share a
 * statusName (e.g. both halves of a fork/join), so a status-driven sync is
 * ambiguous by nature. To avoid teleporting the workspace across the graph:
 * keep the current node if it already matches; otherwise walk outward from the
 * current node (BFS over workflow edges, either direction) and take the NEAREST
 * matching node. If the issue has no current node yet (fresh issue with a
 * template assigned, e.g. right after creation) there is no existing position
 * to protect — that is initialization, not a teleport — so fall back to the
 * first template-order node matching the status.
 *
 * #381 decides what happens when NO node matches at all. The node used to be
 * left alone, which is the root cause: a workflow template only covers a SUBSET
 * of the project's statuses (a typical bugfix template has nodes for In Progress
 * / In Review / Done but none for Backlog, Todo, AI Reviewed or Cancelled), so
 * the issue kept a node naming a DIFFERENT status than it was now in — and every
 * consumer that derives an "effective status" from `workspaces.current_node_id`
 * (`buildBoardColumns` in the board view, `selectMainWorkspace` in
 * `get_board_status`) then silently overrode the move. Observed: three issues
 * moved back to Backlog kept rendering in the In Review column indefinitely,
 * unaffected by a full server restart, because the stale node still said
 * "In Review". The fix clears the node — but only for a BACKWARDS move (the new
 * status sorts before the stale node's status). A forward move off the graph
 * must keep the node: `AI Reviewed` has no node in these templates either, yet a
 * workspace parked there still has to be able to advance, and advancing reads
 * `currentNodeId` to find its outgoing transitions. Clearing is recoverable
 * anyway — moving the issue to a status the template DOES cover re-points the
 * node on the next sync.
 *
 * Composed: #999 computes the match, and only when there is NO match does #381's
 * clear-or-leave decision apply.
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
  // If the current node already maps to this status, leave it.
  const current = nodes.find((n) => n.id === issue.currentNodeId);
  if (current && current.statusName === statusName) return;

  // #999: pick the NEAREST matching node rather than an arbitrary one.
  let match: (typeof nodes)[number] | undefined;
  if (current) {
    const matchId = await findNearestMatchingNode(db, issue.workflowTemplateId, nodes, current.id, statusName);
    match = matchId ? nodes.find((n) => n.id === matchId) : undefined;
  } else {
    // No current node to anchor from (e.g. fresh issue) - this is
    // initialization, not a teleport, so pick the first template-order node.
    match = nodes.find((n) => n.statusName === statusName);
  }
  // #381: no node matches at all -> clear on a backwards move, leave on a forward one.
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
