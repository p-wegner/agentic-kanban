import { and, eq, asc, sql } from "drizzle-orm";
import * as schema from "../../schema/index.js";
import type { WorkflowDb, WorkflowNodeRow, TransitionTarget } from "./types.js";

/** The start node of a template (nodeType 'start', or lowest sortOrder fallback). */
export async function getStartNode(
  db: WorkflowDb,
  templateId: string,
): Promise<WorkflowNodeRow | null> {
  const nodes = await db
    .select()
    .from(schema.workflowNodes)
    .where(eq(schema.workflowNodes.templateId, templateId))
    .orderBy(asc(schema.workflowNodes.sortOrder));
  if (nodes.length === 0) return null;
  return (nodes.find((n) => n.nodeType === "start") ?? nodes[0]);
}

export async function getNode(db: WorkflowDb, nodeId: string): Promise<WorkflowNodeRow | null> {
  const rows = await db
    .select()
    .from(schema.workflowNodes)
    .where(eq(schema.workflowNodes.id, nodeId))
    .limit(1);
  return (rows[0]) ?? null;
}

/** Valid outgoing transitions from a node (with target node + status info). */
export async function getOutgoingTransitions(
  db: WorkflowDb,
  nodeId: string,
): Promise<TransitionTarget[]> {
  const rows = await db
    .select({
      edgeId: schema.workflowEdges.id,
      toNodeId: schema.workflowEdges.toNodeId,
      label: schema.workflowEdges.label,
      condition: schema.workflowEdges.condition,
      sortOrder: schema.workflowEdges.sortOrder,
      toNodeName: schema.workflowNodes.name,
      toStatusName: schema.workflowNodes.statusName,
    })
    .from(schema.workflowEdges)
    .innerJoin(schema.workflowNodes, eq(schema.workflowEdges.toNodeId, schema.workflowNodes.id))
    .where(eq(schema.workflowEdges.fromNodeId, nodeId))
    .orderBy(asc(schema.workflowEdges.sortOrder));
  return rows.map((r) => ({
    edgeId: r.edgeId,
    toNodeId: r.toNodeId,
    toNodeName: r.toNodeName,
    toStatusName: r.toStatusName,
    label: r.label,
    condition: r.condition,
  }));
}

/** How many times a workspace has already entered a given node (for maxVisits). */
export async function countNodeVisits(
  db: WorkflowDb,
  workspaceId: string,
  nodeId: string,
): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)` })
    .from(schema.workflowTransitions)
    .where(
      and(
        eq(schema.workflowTransitions.workspaceId, workspaceId),
        eq(schema.workflowTransitions.toNodeId, nodeId),
      ),
    );
  return Number(rows[0]?.c ?? 0);
}

/**
 * Find the parallel-join node belonging to a SPECIFIC fork by following the
 * graph: the fork's outgoing edges lead to its entry (branch) nodes, whose
 * outgoing edges lead to the join. Supports templates with multiple fork/join
 * pairs (e.g. plan fork + review fork) — findJoinNode(templateId) alone would
 * always return the first join in the template. Falls back to the template-wide
 * lookup when the walk finds nothing.
 */
export async function findJoinNodeForFork(
  db: WorkflowDb,
  forkNode: WorkflowNodeRow,
): Promise<WorkflowNodeRow | null> {
  const entryEdges = await getOutgoingTransitions(db, forkNode.id);
  for (const edge of entryEdges) {
    const entry = await getNode(db, edge.toNodeId);
    if (!entry) continue;
    if (entry.nodeType === "parallel-join") return entry;
    const next = await getOutgoingTransitions(db, entry.id);
    for (const t of next) {
      const candidate = await getNode(db, t.toNodeId);
      if (candidate?.nodeType === "parallel-join") return candidate;
    }
  }
  return findJoinNode(db, forkNode.templateId);
}

/** Find the (first) parallel-join node in a template, if any. */
export async function findJoinNode(
  db: WorkflowDb,
  templateId: string,
): Promise<WorkflowNodeRow | null> {
  const nodes = await db
    .select()
    .from(schema.workflowNodes)
    .where(eq(schema.workflowNodes.templateId, templateId))
    .orderBy(asc(schema.workflowNodes.sortOrder));
  return (nodes.find((n) => n.nodeType === "parallel-join") as WorkflowNodeRow) ?? null;
}
