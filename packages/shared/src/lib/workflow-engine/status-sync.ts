import { and, eq, asc, sql } from "drizzle-orm";
import * as schema from "../../schema/index.js";
import type { WorkflowDb } from "./types.js";

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
 * No-op when the issue has no workflow or no node maps to the status.
 *
 * Several nodes can share a statusName (e.g. both halves of a fork/join), so a
 * status-driven sync is ambiguous by nature (#999). To avoid teleporting the
 * workspace across the graph: keep the current node if it already matches;
 * otherwise walk outward from the current node and take the nearest matching
 * node; otherwise leave currentNodeId untouched and let transitions own
 * placement.
 *
 * If the issue has no current node yet (fresh issue with a workflow template
 * assigned, e.g. right after creation), there is no existing position to
 * protect — this is initialization, not a teleport — so fall back to the
 * first template-order node matching the status.
 */
export async function syncCurrentNodeToStatus(db: WorkflowDb, issueId: string): Promise<void> {
  const issueRows = await db
    .select({ workflowTemplateId: schema.issues.workflowTemplateId, statusId: schema.issues.statusId, currentNodeId: schema.issues.currentNodeId })
    .from(schema.issues)
    .where(eq(schema.issues.id, issueId))
    .limit(1);
  const issue = issueRows[0];
  if (!issue?.workflowTemplateId || !issue.statusId) return;

  const statusRows = await db
    .select({ name: schema.projectStatuses.name })
    .from(schema.projectStatuses)
    .where(eq(schema.projectStatuses.id, issue.statusId))
    .limit(1);
  const statusName = statusRows[0]?.name;
  if (!statusName) return;

  const nodes = await db
    .select()
    .from(schema.workflowNodes)
    .where(eq(schema.workflowNodes.templateId, issue.workflowTemplateId))
    .orderBy(asc(schema.workflowNodes.sortOrder));
  // If the current node already maps to this status, leave it.
  const current = nodes.find((n) => n.id === issue.currentNodeId);
  if (current && current.statusName === statusName) return;

  let match: (typeof nodes)[number] | undefined;
  if (current) {
    const matchId = await findNearestMatchingNode(db, issue.workflowTemplateId, nodes, current.id, statusName);
    match = matchId ? nodes.find((n) => n.id === matchId) : undefined;
  } else {
    // No current node to anchor from (e.g. fresh issue) — this is
    // initialization, not a teleport, so pick the first template-order node.
    match = nodes.find((n) => n.statusName === statusName);
  }
  if (match) {
    await db.update(schema.issues).set({ currentNodeId: match.id }).where(eq(schema.issues.id, issueId));
    // Also sync non-closed workspaces so the board's workflow-status override
    // reflects the new node immediately (workspaces.currentNodeId drives the
    // board column override in getBoard(); without this the board keeps showing
    // the old workflow column until the workspace-summary cache rebuilds).
    await db
      .update(schema.workspaces)
      .set({ currentNodeId: match.id })
      .where(and(eq(schema.workspaces.issueId, issueId), sql`${schema.workspaces.status} != 'closed'`));
  }
}
