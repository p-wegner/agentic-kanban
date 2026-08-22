/**
 * The builder's graph VALUE: what a react-flow graph looks like here, and how to copy and
 * compare one so undo/redo works (#722).
 *
 * `workflowHistory.ts` is generic over a snapshot type and never touches its contents; this
 * module supplies the contents. Both halves of the undo/redo contract live here because
 * they are the same decision: a snapshot must be deep enough that a later mutation of the
 * live graph cannot reach back into a stored past state (react-flow mutates `position` and
 * `data` in place), and "did anything actually change" must be judged on exactly the fields
 * the snapshot copies. Splitting the clone from the comparison is how one of them silently
 * stops covering a field the other does.
 */
import type { Edge, Node } from "@xyflow/react";

/** The per-node payload the builder carries on a react-flow node. */
export type NodeData = {
  label: string;
  nodeType: string;
  statusName: string | null;
  skillId: string | null;
  skillName: string | null;
  maxVisits: number;
  config: string | null;
};

/** Arbitrary data carried on a react-flow edge in this builder. */
export type EdgeData = {
  label: string | null;
  condition: string;
  isLoop: boolean;
};

/** One undoable state of the builder: the graph plus what was selected in it. */
export type WorkflowSnapshot = {
  nodes: Node<NodeData>[];
  edges: Edge[];
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
};

/** Copy nodes deeply enough that later in-place react-flow mutation can't reach a snapshot. */
export function cloneNodes(nodes: Node<NodeData>[]): Node<NodeData>[] {
  return nodes.map((node) => ({
    ...node,
    position: { ...node.position },
    data: { ...node.data },
    style: node.style ? { ...node.style } : node.style,
  }));
}

/** Copy edges deeply enough that later in-place react-flow mutation can't reach a snapshot. */
export function cloneEdges(edges: Edge[]): Edge[] {
  return edges.map((edge) => ({
    ...edge,
    data: edge.data ? { ...edge.data } : edge.data,
  }));
}

/**
 * Whether two node lists agree on every node's position — the test for "this drag moved
 * nothing", so a click on a node does not push an empty entry onto the undo stack.
 */
export function sameNodePositions(a: Node<NodeData>[], b: Node<NodeData>[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(b.map((node) => [node.id, node]));
  return a.every((node) => {
    const other = byId.get(node.id);
    return other?.position.x === node.position.x && other.position.y === node.position.y;
  });
}
